# Agent API — Radhe print agent ↔ CRM

For the C# print agent (T40 / T41). Built in T39; rules in DECISIONS D64 / D65 and ARCHITECTURE §11. Server code:
`web/src/lib/agent.ts`, routes under `web/src/app/api/agent/`, tests in `web/src/lib/agent.test.ts`.

## Basics

- **Base URL**: the CRM's address + `/api/agent` (dev: `http://localhost:3000/api/agent`). HTTPS in production.
- **Auth**: every call except `POST /pair` sends `Authorization: Bearer <device token>`. No header, an unknown token or
  a revoked device → **401**. A browser session cookie is never accepted here.
- **JSON** in and out (`Content-Type: application/json`), UTF-8, request bodies up to 64 KB (thumbnails: raw bytes, 4 MB).
- **Decimals are strings, never JSON numbers** (no floats anywhere): sizes and quantities up to 3 decimals
  (`"6"`, `"2.5"`, `"0.125"`), money in rupees up to 2 decimals (`"25"`, `"1,250.50"` and `"1250.5"` also read).
  Ids are JSON integers (a numeric string is accepted too). Rupee amounts the CRM sends are strings like `"25.00"`.
- **Times**: ISO 8601 with an offset — `"2026-10-02T14:35:12+05:30"` or UTC `"2026-10-02T09:05:12Z"`. A time without
  an offset is refused.
- **Errors**: `{ "error": "message for a person", "field": "json_key" }` (`field` only when one key is at fault).

| Status | Meaning | What the agent does |
|---|---|---|
| 200 / 201 | done (201 = created now, 200 = already there) | carry on |
| 400 | the request is wrong (bad field, unknown id, rule broken) | don't resend it as is: show the error, let the operator fix the print |
| 401 | not paired: no / unknown / revoked token, or (pair) a wrong / used / expired code | stop sending; ask for a new pairing code |
| 404 | (thumbnail) no such print job from this device | drop the thumbnail |
| 413 / 415 | (thumbnail) over 4 MB / not a JPEG, PNG or WebP image | drop or re-make it smaller |
| 5xx, network down | the CRM couldn't answer | keep it in the queue and retry with backoff |

## 1. Pair — `POST /api/agent/pair` (no token)

The owner opens **Settings → Devices → New pairing code** in the CRM and reads out the code (8 characters, shown once,
valid **10 minutes**, pairs **one** PC). Case, spaces and the dash don't matter.

```http
POST /api/agent/pair
Content-Type: application/json

{ "code": "K7QM-3XRD", "name": "Front desk PC" }
```

**201**
```json
{ "token": "pD2c9w2C3m1lW0xKX0b0Z2b3Yk1c0eGJmS2pVZ1d6a0E", "device": { "id": 3, "name": "Front desk PC" } }
```

- `token`: 32 random bytes, base64url (43 characters). **Returned this once** — the CRM keeps only its SHA-256. Store it
  protected (DPAPI, D65). Lost token = pair again.
- `name`: 1–100 characters (the PC's name; the owner can rename it later).
- **401** `{ "error": "That pairing code is wrong, used or expired. …" }` · **400** no name / not JSON.

## 2. Bootstrap — `GET /api/agent/bootstrap`

What the popup picks from. Cache it for offline use; refresh at start and every few minutes.

**200**
```json
{
  "server_time": "2026-10-02T09:05:00.000Z",
  "device": { "id": 3, "name": "Front desk PC" },
  "customers": [{ "id": 12, "name": "ABC Enterprise", "firm_name": "ABC Signs", "mobile": "98250 12345" }],
  "jobs": [{ "id": 41, "number": "RDS-2026-00125", "customer_id": 12, "status": "In Production" }],
  "machines": [{ "id": 1, "name": "UV Roll to Roll", "printer_names": ["UV-ROLL-1"], "sale_rate": "25.00" }],
  "printing_types": [{ "id": 2, "name": "Vinyl" }],
  "operators": [{ "id": "u_8f2kq…", "name": "Mahesh" }]
}
```

- `customers`: active ones only. `jobs`: open jobs (In Production / Ready / Delivered) — no money. `machines`: active,
  with the Windows printer names that feed them (one printer → one machine) and the **sale rate per sq ft** (`null`
  until set: the popup then asks for a rate). **Never a cost rate.** `printing_types`: active. `operators`: active CRM
  users — the agent config maps each Windows user to one of these ids.
- `server_time`: compare with the PC clock; warn if it is more than a few minutes off (prints carry the PC's time).

## 3. Create a print job — `POST /api/agent/print-jobs`

One print from the popup (P2), sent from the offline queue. Saved exactly like the CRM's "New print job" form.

```http
POST /api/agent/print-jobs
Authorization: Bearer <token>
Content-Type: application/json
```
```json
{
  "client_uuid": "6f1c2a4e-3b7d-4c55-9a51-0d8e1f2a7b90",
  "operator_user_id": "u_8f2kq…",
  "printed_at": "2026-10-02T14:35:12+05:30",
  "customer_id": 12,
  "new_customer": null,
  "job_id": null,
  "file_name": "ABC_FRONT_BOARD.cdr",
  "file_path": "D:\\RADHE JOBS\\ABC\\ABC_FRONT_BOARD.cdr",
  "machine_id": 1,
  "printing_type_id": 2,
  "width": "6",
  "height": "3",
  "qty": "2",
  "rate": "25",
  "payment": "unpaid",
  "received": "500",
  "receipt_mode": "cash",
  "reprint_of_id": null,
  "notes": null
}
```

**201** (saved now) / **200** (this `client_uuid` was saved before — nothing new is saved)
```json
{ "id": 108, "number": "PJ/26-27/00108", "customer_id": 12, "duplicate": false }
```

| Key | Rule |
|---|---|
| `client_uuid` | required, a UUID made by the agent **once per print** and kept with it in the queue. Resending the same one (a retry, a duplicate sync, two copies at once) never makes a second print job: you get the first one back with `duplicate: true`. |
| `operator_user_id` | required, an **active** CRM user (from bootstrap `operators`). Any role. They are recorded as the operator, as the audit user and as "received by" on the receipt. |
| `printed_at` | required, when PRINT was pressed, from the PC clock with its offset. Older prints from the queue are fine (no backdate approval); refused if more than 10 minutes in the future or before the books start date. The print's date (and its PJ/ year) is this time in India. |
| `customer_id` / `new_customer` | exactly one. `new_customer: { "name": "…", "mobile": "…" }` is the popup's quick add (unregistered, Gujarat): a mobile an active customer already has (same last 10 digits) returns **that** customer instead; the answer's `customer_id` tells you which — add it to the cache. |
| `job_id` | `null` = a **new** print (a sale, billed later). An open job of that customer = a print **on that job**: costed by the CRM at the machine's cost rate — send **no `rate` and no payment** (`rate`, `payment`, `received`, `receipt_mode` all `null`). A machine with no cost rate yet never refuses it: it is saved with its cost pending and costed when the owner sets the rate (D66). |
| `file_name` | required (≤ 260 characters); `file_path` optional (≤ 1,000), the full path for "Open file" and the reprint check. |
| `machine_id`, `printing_type_id` | required, active ones from bootstrap. |
| `width`, `height` | feet, decimal strings, more than 0 and up to 1000. `qty` copies, more than 0. sq ft = width × height × qty (rounded to 3 decimals, half up). |
| `rate` | new prints only: rupees per sq ft; `null` = the machine's sale rate (refused if the machine has none). Amount = sq ft × rate, rounded to the paisa, half up. |
| `payment` | new prints only: `"paid"` (the full amount taken now; `received` `null` or exactly the amount), `"unpaid"` (`received` = an advance, `null` / up to the amount) or `"credit"` (nothing now; `received` must be empty). |
| `receipt_mode` | `"cash"` or `"upi"`, required when money was taken (it goes to the Cash / UPI account). |
| `reprint_of_id` | the print job this one reprints (from the reprint check), or `null`. |
| `notes` | optional text. |

Money taken becomes a CRM receipt (numbered RC/…) allocated to the print job, in the same transaction.
**400** examples: `{"error": "printed_at is in the future: check the PC's clock.", "field": "printed_at"}` ·
`{"error": "width must be text (decimals as text, e.g. \"2.5\").", "field": "width"}` ·
`{"error": "Pick the machine from the list.", "field": "machine_id"}`.
A 400 won't succeed on a resend; keep the print in the queue marked failed and show the message.

## 4. Reprint check — `GET /api/agent/reprint-check?path=…&name=…`

Before the popup (P8): has this file been printed? Send the full path, the file name, or both (URL-encoded). Matches
the same full path **or** the same file name, case ignored; newest first, at most 5; cancelled print jobs left out.

```http
GET /api/agent/reprint-check?path=D%3A%5CRADHE%20JOBS%5CABC%5CABC_FRONT_BOARD.cdr&name=ABC_FRONT_BOARD.cdr
```

**200**
```json
{
  "matches": [
    {
      "id": 108,
      "number": "PJ/26-27/00108",
      "printed_at": "2026-10-02T09:05:12.000Z",
      "customer": { "id": 12, "name": "ABC Enterprise" },
      "job": null,
      "file_name": "ABC_FRONT_BOARD.cdr",
      "file_path": "D:\\RADHE JOBS\\ABC\\ABC_FRONT_BOARD.cdr",
      "machine_id": 1,
      "printing_type_id": 2,
      "width": "6",
      "height": "3",
      "qty": "2",
      "rate": "25.00"
    }
  ]
}
```

`matches: []` = never printed → a new print. Otherwise ask **New print job or Reprint**: a reprint is a new print job
(its own qty and amount) sent with `"reprint_of_id": <id>`; the popup can start from the match's customer, job,
machine, type and size. `rate` is a new print's rate; `null` for a print on a job (its cost is the CRM's). **400**
when neither `path` nor `name` is sent.

## 5. Thumbnail — `POST /api/agent/print-jobs/{id}/thumbnail?name=front.jpg`

The print's preview (P7), after the print job was created (`id` from its answer). The body is the image's raw bytes;
the type is read from the bytes themselves (JPEG, PNG or WebP), whatever `Content-Type` says. `name` is optional.

```http
POST /api/agent/print-jobs/108/thumbnail?name=ABC_FRONT_BOARD.jpg
Authorization: Bearer <token>
Content-Type: image/jpeg

<bytes>
```

**201** `{ "id": 57, "duplicate": false }` · **200** a thumbnail is already there (the first one stays) ·
**404** not a print job this device created · **413** over 4 MB · **415** not a JPEG / PNG / WebP image.
Keep thumbnails small (a few hundred pixels): they are shown on the print job page.

## Notes for the agent

- **Queue first**: PRINT saves the print (with its `client_uuid`) locally, the job prints, then sync sends it. Retry
  network errors and 5xx with backoff, in order, forever; never change a queued print's `client_uuid`.
- **401 on any call** = the device was revoked or never paired: stop syncing (keep the queue) and ask for a new code.
- **"Open file"** in the CRM is a `radhe-crm://open?path=<url-encoded full path>` link handled by the agent (T41):
  only under its configured roots and only design / image / PDF files (.cdr .ai .pdf .eps .psd .tif .tiff .jpg .jpeg
  .png); never .exe .bat .cmd .ps1 .vbs .lnk .msi or anything else (ARCHITECTURE §11).
