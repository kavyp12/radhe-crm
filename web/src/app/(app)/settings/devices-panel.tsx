"use client";

import { useCallback, useState, useTransition } from "react";
import { DateText } from "@/components/date-text";
import { ActionDialog } from "@/components/doc-actions";
import { Field, FormSection } from "@/components/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FormState } from "@/lib/action";
import { formatDateTime } from "@/lib/dates";
import { CategoryDialog } from "../categories/categories-tables";

type Action = (state: FormState, form: FormData) => Promise<FormState>;
/** A paired PC with its own bound server actions. */
export type DeviceRow = { id: number; name: string; createdAt: Date; lastSeenAt: Date | null; revokedAt: Date | null; rename: Action; revoke: Action };

const th = "h-9 border-b px-3 text-left text-xs font-medium whitespace-nowrap text-muted-foreground";
const td = "border-b px-3 py-2 whitespace-nowrap";

/**
 * Settings → Devices (T39): the PCs running the print agent. A pairing code is typed into the agent once (10 minutes,
 * single use); a revoked device's token stops working at once.
 */
export function DevicesPanel({ devices, newCode }: { devices: DeviceRow[]; newCode: () => Promise<{ code: string; expiresAt: Date }> }) {
  const [code, setCode] = useState<{ code: string; expiresAt: Date } | null>(null);
  const [renaming, setRenaming] = useState<DeviceRow | null>(null);
  const close = useCallback(() => setRenaming(null), []);
  const [pending, start] = useTransition();

  return (
    <div className="grid grid-cols-1 gap-4">
      <FormSection
        title="Pair a PC"
        description="Make a code, then type it into the Radhe print agent on that PC within 10 minutes. Each code pairs one PC."
      >
        <div className="flex flex-wrap items-center gap-4">
          <Button type="button" disabled={pending} onClick={() => start(async () => setCode(await newCode()))}>
            {pending ? "Making…" : "New pairing code"}
          </Button>
          {code && (
            <p className="text-sm">
              <span className="mr-2 font-mono text-xl font-medium tracking-widest">{code.code}</span>
              <span className="text-muted-foreground">valid until {formatDateTime(code.expiresAt).slice(11)}</span>
            </p>
          )}
        </div>
      </FormSection>

      <section aria-label="Devices" className="overflow-x-auto rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-medium">Devices</h2>
        </div>
        {devices.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">No PC is paired yet.</p>
        ) : (
          <table className="w-full min-w-140 border-separate border-spacing-0 text-[13px]">
            <thead>
              <tr>
                <th className={th}>Name</th>
                <th className={th}>Paired</th>
                <th className={th}>Last seen</th>
                <th className={th}>Status</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td className={`${td} font-medium`}>{d.name}</td>
                  <td className={td}>
                    <DateText at={d.createdAt} />
                  </td>
                  <td className={td}>{d.lastSeenAt ? <DateText at={d.lastSeenAt} /> : "Never"}</td>
                  <td className={td}>
                    {d.revokedAt ? (
                      <span className="text-muted-foreground">
                        Revoked <DateText at={d.revokedAt} />
                      </span>
                    ) : (
                      "Active"
                    )}
                  </td>
                  <td className={`${td} text-right`}>
                    {!d.revokedAt && (
                      <div className="flex justify-end gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={() => setRenaming(d)}>
                          Rename
                        </Button>
                        <ActionDialog
                          action={d.revoke}
                          label="Revoke"
                          title={`Revoke ${d.name}?`}
                          description="Its token stops working at once: it can't send prints or read customers any more. Pair it again with a new code."
                          confirmLabel="Revoke device"
                          done="Revoked."
                          variant="destructive"
                        />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {renaming && (
        <CategoryDialog
          key={renaming.id}
          title={`Rename ${renaming.name}`}
          description="The name is only for you; the agent keeps its token."
          action={renaming.rename}
          onClose={close}
          fields={(error) => (
            <Field label="Name" error={error("name")}>
              <Input name="name" defaultValue={renaming.name} required maxLength={100} />
            </Field>
          )}
        />
      )}
    </div>
  );
}
