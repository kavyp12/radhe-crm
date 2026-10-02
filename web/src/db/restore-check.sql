-- Restore check (T36, docs/BACKUP.md): run on the source DB and on the restored copy, then compare the two outputs.
-- The row count of every table, then the AR / AP / stock / cash balances from the journal (paise, + = Dr).
select table_schema || '.' || table_name as "table",
  (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint as "rows"
from information_schema.tables
where table_type = 'BASE TABLE' and table_schema in ('public', 'drizzle')
order by 1;
select a.system_key as "account", coalesce(sum(l.debit_paise - l.credit_paise), 0) as "balance_paise (Dr +)"
from accounts a left join journal_lines l on l.account_id = a.id
where a.system_key in ('ar', 'ap', 'stock', 'cash', 'petty_cash')
group by a.system_key order by 1;
