import { DatabaseSync } from 'node:sqlite'

// 仅使用内存中的合成媒体记录验证真实 SQLite 筛选与排序。
const { where, orderBy, rows } = JSON.parse(process.argv[2])
const db = new DatabaseSync(':memory:')
db.exec('CREATE TABLE media (_id INTEGER, media_type INTEGER, datetaken INTEGER, date_added INTEGER, _display_name TEXT)')
const insert = db.prepare('INSERT INTO media VALUES (?, ?, ?, ?, ?)')
for (const row of rows) insert.run(...row, ...(row.length === 4 ? [''] : []))
const order = orderBy.map(({ column, isAsc }) => `${column} ${isAsc ? 'ASC' : 'DESC'}`).join(', ')
console.log(JSON.stringify(db.prepare(`SELECT _id FROM media WHERE ${where} ORDER BY ${order}`).all().map(row => row._id)))
db.close()
