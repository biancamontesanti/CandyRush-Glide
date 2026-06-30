import { engine, Schemas } from '@dcl/sdk/ecs'
const Test = engine.defineComponent('test', { token: Schemas.Int64 })
const e = engine.addEntity()
Test.create(e, { token: Date.now() })
console.log(typeof Test.get(e).token)
