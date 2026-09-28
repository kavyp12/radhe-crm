"use client";

import { useState } from "react";
import { Field } from "@/components/form";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { GST_STATES } from "@/lib/gstin";

/**
 * GSTIN + state fields (form names "gstin" / "stateCode") for a customer or vendor form grid. Typing a GSTIN picks
 * the state it starts with; the server checks both again (lib/gstin.ts stateAndGstin).
 */
export function GstinStateFields({
  gstin,
  stateCode,
  error,
}: {
  gstin: string;
  stateCode: string;
  error: (field: string) => string | undefined;
}) {
  const [state, setState] = useState(stateCode);
  return (
    <>
      <Field label="GSTIN" hint="Blank if unregistered." error={error("gstin")}>
        <Input
          name="gstin"
          defaultValue={gstin}
          maxLength={15}
          autoCapitalize="characters"
          spellCheck={false}
          className="uppercase"
          onChange={(e) => {
            const code = e.target.value.trim().slice(0, 2);
            if (GST_STATES.some(([c]) => c === code)) setState(code);
          }}
        />
      </Field>
      <Field label="State" hint="Must match the GSTIN. Pick it when unregistered." error={error("stateCode")}>
        <NativeSelect name="stateCode" value={state} onChange={(e) => setState(e.target.value)} className="w-full">
          {GST_STATES.map(([code, name]) => (
            <NativeSelectOption key={code} value={code}>
              {code} · {name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
    </>
  );
}

/**
 * Warns, never blocks, when another customer / vendor already has this GSTIN or mobile (D46): spread onBlur on the
 * form; `check` is a server action returning the warning or null.
 */
export function useDuplicateCheck(check: (gstin: string, mobile: string) => Promise<string | null>) {
  const [note, setNote] = useState<string | null>(null);
  const onBlur = (e: React.FocusEvent<HTMLFormElement>) => {
    const { name } = e.target as EventTarget as HTMLInputElement;
    if (name !== "gstin" && name !== "mobile") return;
    const data = new FormData(e.currentTarget);
    check(String(data.get("gstin") ?? ""), String(data.get("mobile") ?? "")).then(setNote, () => setNote(null));
  };
  const warning = note && (
    <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {note}
    </p>
  );
  return { onBlur, warning };
}
