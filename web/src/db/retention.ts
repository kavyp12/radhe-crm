// Which backup dumps to delete (docs/BACKUP.md: keep 7 daily, 4 weekly, 12 monthly). Kept: the newest dump of each of
// the 7 latest days, the 4 latest weeks (Monday to Sunday) and the 12 latest months that have one. File names are
// <prefix>-YYYY-MM-DD-HHmm.dump (India time, src/db/backup.ts); other files are never touched.

const mondayOf = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

export function dumpsToPrune(files: string[], prefix: string): string[] {
  const dumps = files
    .flatMap((file) => {
      const m = file.startsWith(prefix) ? file.slice(prefix.length).match(/^-(\d{4}-\d{2}-\d{2})-(\d{4})\.dump$/) : null;
      return m ? [{ file, day: m[1], stamp: `${m[1]} ${m[2]}` }] : [];
    })
    .sort((a, b) => (a.stamp < b.stamp ? 1 : -1)); // newest first
  const keep = new Set<string>();
  const newestOfEach = (period: (day: string) => string, count: number) => {
    const seen = new Set<string>();
    for (const d of dumps) {
      const p = period(d.day);
      if (seen.has(p)) continue;
      if (seen.size === count) break;
      seen.add(p);
      keep.add(d.file);
    }
  };
  newestOfEach((day) => day, 7);
  newestOfEach(mondayOf, 4);
  newestOfEach((day) => day.slice(0, 7), 12);
  return dumps.filter((d) => !keep.has(d.file)).map((d) => d.file);
}
