// INFRA-74: кандидат списка «спросить» — одинаково для Bash и PowerShell, с формой «git -C <папка> …».
// Печатает JSON-массив правил; им же пользуется проба (через --settings) и правка ~/.claude/settings.json.
const shells = ['Bash', 'PowerShell']
const common = [
  'git push*', 'git -C * push*',
  '*_db-runner*', '*run.mjs*', '*wrangler*', '*railway*',
  'git reset --hard*', 'git -C * reset --hard*',
  'git clean*', 'git -C * clean*',
  'git branch -D*', 'git -C * branch -D*',
  'rm *',
]
const powershellOnly = ['Remove-Item *', 'del *', 'rd *', 'rmdir *', 'ri *', 'erase *']

const rules = []
for (const s of shells) for (const p of common) rules.push(`${s}(${p})`)
for (const p of powershellOnly) rules.push(`PowerShell(${p})`)
process.stdout.write(JSON.stringify(rules))
