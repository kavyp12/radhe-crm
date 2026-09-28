import { UserError } from "@/lib/action";

// GST state codes and GSTIN checks (A§4). Customer / vendor state = the GSTIN's first 2 digits; unregistered
// parties pick their state. Plain data + functions, safe to import in client components.

/**
 * State codes exactly as the GST e-Invoice portal (GSTN / NIC) lists them: "State Codes" on
 * https://einvoice1.gst.gov.in/Others/MasterCodes, fetched 28/09/2026 (names title-cased). The list has no 28.
 */
export const GST_STATES: readonly (readonly [code: string, name: string])[] = [
  ["01", "Jammu and Kashmir"],
  ["02", "Himachal Pradesh"],
  ["03", "Punjab"],
  ["04", "Chandigarh"],
  ["05", "Uttarakhand"],
  ["06", "Haryana"],
  ["07", "Delhi"],
  ["08", "Rajasthan"],
  ["09", "Uttar Pradesh"],
  ["10", "Bihar"],
  ["11", "Sikkim"],
  ["12", "Arunachal Pradesh"],
  ["13", "Nagaland"],
  ["14", "Manipur"],
  ["15", "Mizoram"],
  ["16", "Tripura"],
  ["17", "Meghalaya"],
  ["18", "Assam"],
  ["19", "West Bengal"],
  ["20", "Jharkhand"],
  ["21", "Odisha"],
  ["22", "Chhattisgarh"],
  ["23", "Madhya Pradesh"],
  ["24", "Gujarat"],
  ["25", "Daman and Diu"],
  ["26", "Dadra and Nagar Haveli"],
  ["27", "Maharashtra"],
  ["29", "Karnataka"],
  ["30", "Goa"],
  ["31", "Lakshadweep"],
  ["32", "Kerala"],
  ["33", "Tamil Nadu"],
  ["34", "Puducherry"],
  ["35", "Andaman and Nicobar"],
  ["36", "Telangana"],
  ["37", "Andhra Pradesh"],
  ["38", "Ladakh"],
  ["96", "Other Countries"],
  ["97", "Other Territory"],
  ["99", "Other Countries"],
];

export const COMPANY_STATE = "24"; // Gujarat, the default for unregistered parties

export const stateName = (code: string) => GST_STATES.find(([c]) => c === code)?.[1];

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The 15th character: Luhn mod 36 over the first 14, factor 2 on the rightmost. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = CHARS.indexOf(first14[13 - i]) * (i % 2 === 0 ? 2 : 1);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

/**
 * A customer's / vendor's state and GSTIN as typed → values (A§4). A GSTIN must check out and start with the state;
 * no GSTIN = unregistered, state as chosen.
 */
export function stateAndGstin(stateInput: string, gstinInput: string) {
  const stateCode = stateInput.trim();
  if (!stateName(stateCode)) throw new UserError("Pick the state.", "stateCode");
  const gstin = gstinInput.replace(/\s/g, "").toUpperCase() || null;
  const problem = gstin && gstinProblem(gstin, stateCode);
  if (problem) throw new UserError(problem, "gstin");
  return { stateCode, gstin };
}

/** Why this GSTIN can't be used for a party in `stateCode`, or null when it is fine. Expects uppercase. */
export function gstinProblem(gstin: string, stateCode: string): string | null {
  if (!GSTIN.test(gstin)) return "A GSTIN is 15 characters, e.g. 24ABCDE1234F1Z5.";
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14]) return "This GSTIN's last character doesn't match: check for a typo.";
  if (!gstin.startsWith(stateCode)) {
    return `This GSTIN is from state ${gstin.slice(0, 2)}; the state chosen is ${stateCode}. Pick the state it starts with.`;
  }
  return null;
}
