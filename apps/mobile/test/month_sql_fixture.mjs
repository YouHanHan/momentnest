import {DatabaseSync} from 'node:sqlite'
const {where, rows}=JSON.parse(process.argv[2])
const db=new DatabaseSync(':memory:')
db.exec('CREATE TABLE media (_id INTEGER,media_type INTEGER,datetaken INTEGER,date_added INTEGER)')
const insert=db.prepare('INSERT INTO media VALUES (?,?,?,?)')
for(const row of rows)insert.run(...row)
console.log(JSON.stringify(db.prepare(`SELECT _id FROM media WHERE ${where} ORDER BY _id`).all().map(row=>row._id)))
db.close()
