// Проба 0.5: сообщение с картинкой в двустороннем stream-json. Печатает одну строку JSON для stdin сессии.
import { readFileSync } from 'node:fs'

const [path, text] = process.argv.slice(2)
const data = readFileSync(path).toString('base64')
process.stdout.write(JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      { type: 'text', text },
    ],
  },
}) + '\n')
