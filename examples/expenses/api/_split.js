// Shared helper. Files under api/ starting with _ are not routes.

/**
 * Settle a set of expenses into the fewest transfers.
 *
 * Everyone shares every expense equally, so each person's balance is what they paid minus
 * their share of the total. Repeatedly matching the largest creditor with the largest debtor
 * gives a minimal-ish set of payments, which is all a group of friends needs.
 */
export function settle(expenses) {
  const people = [...new Set(expenses.map((e) => e.who))];
  if (!people.length) return { total: 0, perPerson: 0, balances: [], transfers: [] };

  const total = expenses.reduce((n, e) => n + e.cents, 0);

  // Rounding each share independently does not add back up to the total: three people and
  // 100 cents gives 33+33+33, and the missing cent makes every balance slightly wrong. Give
  // the remainder out one cent at a time instead, in a fixed order so it is reproducible.
  const sorted = [...people].sort();
  const base = Math.floor(total / sorted.length);
  const remainder = total - base * sorted.length;
  const shareOf = new Map(sorted.map((who, i) => [who, base + (i < remainder ? 1 : 0)]));

  const balances = sorted
    .map((who) => ({
      who,
      paid: expenses.filter((e) => e.who === who).reduce((n, e) => n + e.cents, 0),
      share: shareOf.get(who),
    }))
    .map((b) => ({ ...b, net: b.paid - b.share }))
    .sort((a, b) => b.net - a.net);

  const creditors = balances.filter((b) => b.net > 0).map((b) => ({ ...b }));
  const debtors = balances.filter((b) => b.net < 0).map((b) => ({ ...b, net: -b.net }));
  const transfers = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].net, creditors[j].net);
    if (amount > 0) transfers.push({ from: debtors[i].who, to: creditors[j].who, cents: amount });
    debtors[i].net -= amount;
    creditors[j].net -= amount;
    if (debtors[i].net === 0) i++;
    if (creditors[j].net === 0) j++;
  }
  // perPerson is the even split; individual shares differ by at most a cent (see above).
  return { total, perPerson: base, balances, transfers };
}

export function parseAmount(raw) {
  const n = Number(String(raw ?? '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}
