import { expect, test } from "vitest";
import { amountInWords, divRound, formatMoney, invoiceTotals, lineCalc, parseMoney, parseQty } from "./num";

test("rounding is half away from zero", () => {
  // qty 1.500 × ₹0.33 = 49.5 paise
  expect(lineCalc({ qty: 1500n, rate: 33n, gstBp: 0 }, "estimate").amount).toBe(50n);
  expect(lineCalc({ qty: -1500n, rate: 33n, gstBp: 0 }, "estimate").amount).toBe(-50n);
  expect(divRound(494n, 10n)).toBe(49n);
  expect(divRound(-494n, 10n)).toBe(-49n);
});

test("GST half-paisa case: ₹0.50 taxable at 18%", () => {
  const line = { qty: 1000n, rate: 50n, gstBp: 1800 };
  expect(lineCalc(line, "same_state")).toMatchObject({ taxable: 50n, cgst: 5n, sgst: 5n, igst: 0n });
  expect(lineCalc(line, "other_state")).toMatchObject({ taxable: 50n, cgst: 0n, sgst: 0n, igst: 9n });
  // a negative line mirrors it
  expect(lineCalc({ ...line, qty: -1000n }, "same_state")).toMatchObject({ cgst: -5n, sgst: -5n });
});

test("discount: taxable = amount − discount, never above the amount", () => {
  const line = { qty: 2000n, rate: 10000n, gstBp: 1800 }; // 2 × ₹100
  expect(lineCalc({ ...line, discount: 5000n }, "other_state")).toMatchObject({ amount: 20000n, taxable: 15000n, igst: 2700n });
  expect(lineCalc({ ...line, discount: 20000n }, "other_state").taxable).toBe(0n);
  expect(() => lineCalc({ ...line, discount: 20001n }, "other_state")).toThrow();
  expect(() => lineCalc({ ...line, discount: -1n }, "other_state")).toThrow();
});

test("same lines as same state, other state and estimate", () => {
  const lines = [
    { qty: 12500n, rate: 4500n, discount: 1000n, gstBp: 1800 }, // 12.5 × ₹45 − ₹10 = ₹552.50
    { qty: 2000n, rate: 10000n, gstBp: 1200 }, // 2 × ₹100 = ₹200.00
  ];
  const same = invoiceTotals(lines, "same_state");
  expect(same).toMatchObject({ taxable: 75250n, cgst: 6173n, sgst: 6173n, igst: 0n, roundOff: 4n, total: 87600n });
  expect(same.lines[0]).toMatchObject({ cgst: 4973n, sgst: 4973n }); // 55250 × 9% = 4972.5 paise → 4973

  const other = invoiceTotals(lines, "other_state");
  expect(other).toMatchObject({ taxable: 75250n, cgst: 0n, sgst: 0n, igst: 12345n, roundOff: 5n, total: 87600n });

  const est = invoiceTotals(lines, "estimate");
  expect(est).toMatchObject({ taxable: 75250n, cgst: 0n, sgst: 0n, igst: 0n, roundOff: 50n, total: 75300n });
});

test("round-off to the nearest rupee", () => {
  const one = (rate: bigint) => invoiceTotals([{ qty: 1000n, rate, gstBp: 0 }], "estimate");
  expect(one(123450n)).toMatchObject({ roundOff: 50n, total: 123500n }); // ₹1,234.50 → ₹1,235
  expect(one(123449n)).toMatchObject({ roundOff: -49n, total: 123400n }); // ₹1,234.49 → ₹1,234
  expect(one(123400n)).toMatchObject({ roundOff: 0n, total: 123400n });
});

test("format ₹ en-IN", () => {
  expect(formatMoney(10000000n)).toBe("₹1,00,000.00");
  expect(formatMoney(1234567850n)).toBe("₹1,23,45,678.50");
  expect(formatMoney(-123450n)).toBe("-₹1,234.50");
  expect(formatMoney(5n)).toBe("₹0.05");
  expect(formatMoney(0n)).toBe("₹0.00");
});

test("parse user strings", () => {
  expect(parseMoney("1,00,000.50")).toBe(10000050n);
  expect(parseMoney("100,000.5")).toBe(10000050n);
  expect(parseMoney(" -1,234.5 ")).toBe(-123450n);
  expect(parseMoney("0.05")).toBe(5n);
  expect(parseQty("12.5")).toBe(12500n);
  expect(parseQty("1.234")).toBe(1234n);
  for (const bad of ["1.234", "abc", "", " ", "-", ".5", "5.", "1.2.3", "12,5", "12,50", "1,,000", "+5", "₹5", "1e3"]) {
    expect(() => parseMoney(bad), bad).toThrow();
  }
  expect(() => parseQty("1.2345")).toThrow();
});

test("amount in words, Indian system", () => {
  expect(amountInWords(0n)).toBe("Rupees Zero Only");
  expect(amountInWords(10000000n)).toBe("Rupees One Lakh Only");
  expect(amountInWords(12000050n)).toBe("Rupees One Lakh Twenty Thousand and Fifty Paise Only"); // D30
  expect(amountInWords(1234567850n)).toBe(
    "Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Fifty Paise Only",
  );
  expect(amountInWords(99999999999n)).toBe(
    "Rupees Ninety Nine Crore Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine and Ninety Nine Paise Only",
  );
  expect(amountInWords(50n)).toBe("Rupees Zero and Fifty Paise Only");
  expect(amountInWords(100000000000n)).toBe("Rupees One Hundred Crore Only");
});
