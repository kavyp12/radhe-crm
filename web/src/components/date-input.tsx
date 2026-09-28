"use client";

import { useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { formatDate, parseDate } from "@/lib/dates";
import { cn } from "@/lib/utils";

/** "" when empty, 'YYYY-MM-DD' when valid, null when not a real DD/MM/YYYY date. */
function read(text: string): string | null {
  if (!text.trim()) return "";
  try {
    return parseDate(text);
  } catch {
    return null;
  }
}

type Props = Omit<React.ComponentProps<"input">, "defaultValue" | "value" | "onChange" | "type"> & {
  /** 'YYYY-MM-DD'. */
  defaultValue?: string;
  /** Called with 'YYYY-MM-DD', or null once the field is cleared. */
  onValueChange?: (date: string | null) => void;
};

/**
 * DD/MM/YYYY text field (no date-picker library). With `name`, the form posts the DD/MM/YYYY text and the server
 * parses it again with parseDate. Eight digits (28092026) are accepted and formatted.
 */
export function DateInput({ defaultValue, onValueChange, className, onBlur, ...props }: Props) {
  const [text, setText] = useState(defaultValue ? formatDate(defaultValue) : "");
  const [error, setError] = useState("");
  const errorId = useId();

  function change(raw: string) {
    const next = /^\d{8}$/.test(raw) ? `${raw.slice(0, 2)}/${raw.slice(2, 4)}/${raw.slice(4)}` : raw;
    setText(next);
    const date = read(next);
    if (date === null) return;
    setError("");
    onValueChange?.(date || null);
  }

  return (
    <div className={cn("grid gap-1", className)}>
      <Input
        {...props}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="DD/MM/YYYY"
        maxLength={10}
        value={text}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => change(e.target.value)}
        onBlur={(e) => {
          const date = read(text);
          if (date === null) setError("Use DD/MM/YYYY, e.g. 28/09/2026.");
          else if (date) setText(formatDate(date));
          onBlur?.(e);
        }}
        className="tabular-nums"
      />
      {error && (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
