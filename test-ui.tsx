const fs = require('fs')
let ui = fs.readFileSync('src/ui.tsx', 'utf8')
if (ui.includes('RED ')) {
  console.log("Still has RED")
}
if (ui.includes('BLUE ')) {
  console.log("Still has BLUE")
}
