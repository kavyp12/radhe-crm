// FIFO fill (D49), client-safe: the receipt form runs it live; the server checks whatever was submitted.

/** Spreads `amount` over the open amounts in order, each up to its open amount. The rest stays unallocated. */
export function fifo(amount: bigint, opens: bigint[]): bigint[] {
  let left = amount > 0n ? amount : 0n;
  return opens.map((open) => {
    const take = open > 0n && left > 0n ? (left < open ? left : open) : 0n;
    left -= take;
    return take;
  });
}
