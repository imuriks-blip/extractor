import { appendFileSync } from 'node:fs'
let raw=''; process.stdin.on('data',c=>raw+=c); process.stdin.on('end',()=>{ let j={}; try{j=JSON.parse(raw)}catch{}; appendFileSync('hook-notify.log', JSON.stringify({at:new Date().toISOString(), event:j.hook_event_name, type:j.notification_type, msg:j.message})+'\n') })
