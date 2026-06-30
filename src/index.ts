import {
  engine,
  GltfContainer,
  ColliderLayer,
  Transform,
  VisibilityComponent,
  AudioSource,
  AvatarBase,
  Entity,
  Schemas,
  InputModifier,
  VirtualCamera,
  MainCamera,
  Name
} from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { getPlayerPosition } from '@dcl-sdk/utils'
import { isStateSyncronized, myProfile, syncEntity } from '@dcl/sdk/network'
import { movePlayerTo } from '~system/RestrictedActions'
import {
  setupUi,
  setUiTimer,
  tickUi,
  updateLobbyState,
  updateSoloState,
  updateTeamState,
  showCollectPopup,
  setModeSelectCallback,
  setChangeModeCallback,
  setCloseFinishCallback,
  setJoinTeamCallback,
  setForceStartCallback,
  updateLobbyTeams,
  setCloseLobbyCallback,
  setLobbyClosed,
  LobbyPlayerInfo,
  LeaderboardEntry
} from './ui'

// ── Constants ─────────────────────────────────────────────────────────────────
const COLLECT_SOUND = 'assets/sounds/collect.wav'
const BLUEBERRY_SRC = 'assets/scene/Models/BLUEBERRY/BLUEBERRY.glb'
const STRAWBERRY_SRC = 'assets/scene/Models/STRAWBERRY/STRAWBERRY.glb'

const TEAM_COUNTDOWN = 120
const BERRY_RESPAWN_DELAY = 20
const SOLO_PREGAME_DURATION = 4.99
const TEAM_ASSIGN_INTRO_DURATION = 3
const TEAM_READY_INTRO_DURATION = 3
const TEAM_COUNTDOWN_DURATION = 4
const TEAM_PREGAME_DURATION = TEAM_ASSIGN_INTRO_DURATION + TEAM_READY_INTRO_DURATION + TEAM_COUNTDOWN_DURATION
const TEAM_PREGAME_DURATION_MS = Math.ceil(TEAM_PREGAME_DURATION * 1000)
// How long to wait after teams are ready before the match auto-starts.
// Players can still switch teams or new players can join during this window.
const LOBBY_START_DELAY_MS = 30_000 // 30 seconds

const STRAWBERRY_SCALE_MULTIPLIER = 0.8
const BLUEBERRY_SCALE_MULTIPLIER = 0.8
const STRAWBERRY_CENTER_OFFSET = Vector3.create(9.977967, 0.118668, -3.692565)
const BLUEBERRY_CENTER_OFFSET = Vector3.create(13.098664, -2.31526, -2.112536)
const BERRY_HALF_EXTENTS = Vector3.create(1.2063, 1.6856, 0.8195)
const PLAYER_TOUCH_HEIGHT = 1.9
const BERRY_TOUCH_AVATAR_RADIUS = 0.45
const BERRY_TOUCH_VERTICAL_PADDING = 0.2

// Lobby spawn position — center of parcel, just inside
const LOBBY_X = 8,
  LOBBY_Y = 0,
  LOBBY_Z = 8

const STRAWBERRY_NAMES = [
  'STRAWBERRY.glb',
  'STRAWBERRY.glb_2',
  'STRAWBERRY.glb_3',
  'STRAWBERRY.glb_4',
  'STRAWBERRY.glb_5'
]
const GUMDROP_FALL_DURATION = 0.45
const GUMDROP_FALL_DISTANCE = 3.2
const GUMDROP_RESPAWN_DELAY = 3
const GUMDROP_TOUCH_Y_BELOW = 1.2
const GUMDROP_TOUCH_Y_ABOVE = 1.8

// ── Types ─────────────────────────────────────────────────────────────────────
type Team = 'red' | 'blue'
type GameMode = 'idle' | 'lobby' | 'solo' | 'team'
type TeamPhase = 'idle' | 'waiting' | 'countdown' | 'playing' | 'finished'

type TeamSlot = {
  entity: Entity
  collected: boolean
  wasInside: boolean
  respawnTimer: number
  stateEntity: Entity | null
}

type BerrySpot = {
  x: number
  y: number
  z: number
  baseScale: { x: number; y: number; z: number }
  red: TeamSlot
  blue: TeamSlot
}

type GumdropProfile = {
  centerOffset: { x: number; y: number; z: number }
  topOffset: number
  radius: number
}

type GumdropSpot = {
  entity: Entity
  startPosition: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
  profile: GumdropProfile
  state: 'ready' | 'falling' | 'hidden'
  fallTimer: number
  respawnTimer: number
}

type LobbyPlayer = { userId: string; token: number }

// ── Sync components ───────────────────────────────────────────────────────────
enum SyncIds {
  MatchState = 7000,
  RedBerry0 = 7100,
  BlueBerry0 = 7200,
  SoloLeaderboard = 7300
}

enum TeamCode {
  Red = 0,
  Blue = 1
}

enum MatchPhaseCode {
  Waiting = 0,
  Countdown = 1,
  Playing = 2,
  Finished = 3
}

const TeamPresence = engine.defineComponent('candy-rush::TeamPresence', {
  userId: Schemas.String,
  displayName: Schemas.String,
  wantsTeam: Schemas.Boolean,
  token: Schemas.Int64,
  chosenTeam: Schemas.Int // 0 = unassigned, 1 = red, 2 = blue
})

const MatchState = engine.defineComponent('candy-rush::MatchState', {
  phase: Schemas.Int,
  countdownStart: Schemas.Int64,
  gameStart: Schemas.Int64,
  duration: Schemas.Int,
  redPlayers: Schemas.Array(Schemas.String),
  bluePlayers: Schemas.Array(Schemas.String),
  version: Schemas.Int,
  lobbyTimer: Schemas.Int64,
  hostTime: Schemas.Int64,
  hasWarnedUnbalanced: Schemas.Boolean,
  knownPlayers: Schemas.Array(Schemas.String),
  lobbyPlayers: Schemas.Array(Schemas.String)
})

const BerryState = engine.defineComponent('candy-rush::BerryState', {
  team: Schemas.Int,
  spot: Schemas.Int,
  collected: Schemas.Boolean,
  collectedUntil: Schemas.Int64,
  catches: Schemas.Int
})

const SoloLeaderboardState = engine.defineComponent('candy-rush::SoloLeaderboardState', {
  entries: Schemas.Array(Schemas.String),
  version: Schemas.Int
})

// ── Game state ────────────────────────────────────────────────────────────────
let gameMode: GameMode = 'lobby'

// solo
let soloPhase: 'idle' | 'countdown' | 'playing' | 'finished' = 'idle'
let soloTimer = 0
let soloCountdownTimer = 0

// team
let teamPhase: TeamPhase = 'idle'
let teamTimer = TEAM_COUNTDOWN
let pregameTimer = TEAM_PREGAME_DURATION
let teamScores: Record<Team, number> = { red: 0, blue: 0 }
let localTeam: Team | null = null
// Guards against the game loop re-entering finishTeam() every frame
let shownFinishForVersion = -1

// sync
const MY_TOKEN = Math.floor(Math.random() * 2_000_000_000)
let wantsTeamBattle = false
let myChosenTeam: 0 | 1 | 2 = 0 // 0=unassigned, 1=red, 2=blue
let syncedGameplayReady = false
let syncedDefaultsReady = false
let matchStateEntity: Entity | null = null
let myPresenceEntity: Entity | null = null
let soloLeaderboardEntity: Entity | null = null
let lastPresenceUserId = ''
let lastPresenceWantsTeam: boolean | null = null
let lastPresenceChosenTeam = -1

let lastHostTimeUpdate = 0
let lastTotalReadyOnHost = 0
let hostClockOffset = 0
let lastSeenHostTime = 0
let hasCalibratedOffset = false
let wasStateSynchronizedLastFrame = false

const spots: BerrySpot[] = []
const gumdrops: GumdropSpot[] = []
const collisionReadyModels = new Set<Entity>()
const leaderboard: LeaderboardEntry[] = []
const LEADERBOARD_MAX = 5

// Cinematic camera entity (created once in main)
let cinematicCam: Entity

const GUMDROP_PROFILES: { srcPart: string; profile: GumdropProfile }[] = [
  {
    srcPart: 'gumdrop-1',
    profile: {
      centerOffset: Vector3.create(-1.213, 3.434, -10.538),
      topOffset: 4.437,
      radius: 1.55
    }
  },
  {
    srcPart: 'gumdrop-2',
    profile: {
      centerOffset: Vector3.create(1.28, 11.675, -11.915),
      topOffset: 12.652,
      radius: 1.55
    }
  },
  {
    srcPart: 'gumdrop-3',
    profile: {
      centerOffset: Vector3.create(-2.127, 14.757, -11.436),
      topOffset: 15.705,
      radius: 1.55
    }
  },
  {
    srcPart: 'gumdrop-4',
    profile: {
      centerOffset: Vector3.create(5.917, 17.996, -3.589),
      topOffset: 18.773,
      radius: 1.35
    }
  },
  {
    srcPart: 'gumdrop-5',
    profile: {
      centerOffset: Vector3.create(4.797, 20.479, 4.139),
      topOffset: 21.555,
      radius: 1.55
    }
  },
  {
    srcPart: 'gumdrop-6',
    profile: {
      centerOffset: Vector3.create(9.083, 11.584, 10.358),
      topOffset: 12.587,
      radius: 1.55
    }
  },
  {
    srcPart: 'gumdrop-7',
    profile: {
      centerOffset: Vector3.create(0.949, 10.069, 10.614),
      topOffset: 11.149,
      radius: 1.65
    }
  },
  {
    srcPart: 'gumdrop-8',
    profile: {
      centerOffset: Vector3.create(-3.553, 3.516, 8.706),
      topOffset: 4.469,
      radius: 1.55
    }
  },
  {
    srcPart: 'gumdrop-9',
    profile: {
      centerOffset: Vector3.create(-13.883, 19.831, 1.574),
      topOffset: 20.778,
      radius: 1.5
    }
  }
]

// ── Slot helpers ──────────────────────────────────────────────────────────────
function soloRemaining() {
  return spots.filter((s) => !s.red.collected).length
}

function showSlot(slot: TeamSlot, visible: boolean) {
  VisibilityComponent.createOrReplace(slot.entity, { visible })
}

function resetSlot(slot: TeamSlot, show: boolean) {
  slot.collected = false
  slot.wasInside = false
  slot.respawnTimer = 0
  showSlot(slot, show)
}

function hideAllBerries() {
  for (const s of spots) {
    VisibilityComponent.createOrReplace(s.red.entity, { visible: false })
  }
}

function updateBerryRepresentation(spot: BerrySpot) {
  const entity = spot.red.entity
  if (!GltfContainer.has(entity)) return
  const gltf = GltfContainer.getMutable(entity)

  if (gameMode === 'team' && localTeam === 'blue') {
    if (gltf.src !== BLUEBERRY_SRC) {
      gltf.src = BLUEBERRY_SRC
      Transform.getMutable(entity).scale = scaledBerry(spot.baseScale, BLUEBERRY_SCALE_MULTIPLIER)
    }
    const isVisible = teamPhase === 'playing' && !spot.blue.collected
    VisibilityComponent.createOrReplace(entity, { visible: isVisible })
    if (isVisible) {
      gltf.visibleMeshesCollisionMask = ColliderLayer.CL_POINTER
      gltf.invisibleMeshesCollisionMask = 0
    } else {
      gltf.visibleMeshesCollisionMask = 0
      gltf.invisibleMeshesCollisionMask = 0
    }
  } else {
    if (gltf.src !== STRAWBERRY_SRC) {
      gltf.src = STRAWBERRY_SRC
      Transform.getMutable(entity).scale = scaledBerry(spot.baseScale, STRAWBERRY_SCALE_MULTIPLIER)
    }
    const isVisible =
      (gameMode === 'solo' && soloPhase === 'playing' && !spot.red.collected) ||
      (gameMode === 'team' && teamPhase === 'playing' && localTeam === 'red' && !spot.red.collected)
    VisibilityComponent.createOrReplace(entity, { visible: isVisible })
    if (isVisible) {
      gltf.visibleMeshesCollisionMask = ColliderLayer.CL_POINTER
      gltf.invisibleMeshesCollisionMask = 0
    } else {
      gltf.visibleMeshesCollisionMask = 0
      gltf.invisibleMeshesCollisionMask = 0
    }
  }
}

function closeLobby() {
  exitLobby()
  gameMode = 'idle'
  soloPhase = 'idle'
  soloTimer = 0
  soloCountdownTimer = 0
  teamPhase = 'idle'
  localTeam = null
  myChosenTeam = 0
  wantsTeamBattle = false
  shownFinishForVersion = -1
  lastPresenceChosenTeam = -1
  updateLocalPresence()
  hideAllBerries()
  setLobbyClosed(true)
}

function scaledBerry(base: { x: number; y: number; z: number } | undefined, mul: number) {
  const v = base ?? Vector3.create(1, 1, 1)
  return Vector3.create(v.x * mul, v.y * mul, v.z * mul)
}

function scaleVector(v: { x: number; y: number; z: number }, scale: { x: number; y: number; z: number }) {
  return Vector3.create(v.x * scale.x, v.y * scale.y, v.z * scale.z)
}

function getBerryVisualCenter(spot: BerrySpot) {
  const useBlueberry = gameMode === 'team' && localTeam === 'blue'
  const modelOffset = useBlueberry ? BLUEBERRY_CENTER_OFFSET : STRAWBERRY_CENTER_OFFSET
  const modelScale = scaledBerry(spot.baseScale, useBlueberry ? BLUEBERRY_SCALE_MULTIPLIER : STRAWBERRY_SCALE_MULTIPLIER)
  const offset = scaleVector(modelOffset, modelScale)
  return Vector3.create(spot.x + offset.x, spot.y + offset.y, spot.z + offset.z)
}

function getActiveBerryHalfExtents(spot: BerrySpot) {
  const multiplier = gameMode === 'team' && localTeam === 'blue' ? BLUEBERRY_SCALE_MULTIPLIER : STRAWBERRY_SCALE_MULTIPLIER
  const scale = scaledBerry(spot.baseScale, multiplier)
  return scaleVector(BERRY_HALF_EXTENTS, scale)
}

function isPlayerTouchingBerry(pos: { x: number; y: number; z: number }, spot: BerrySpot) {
  const center = getBerryVisualCenter(spot)
  const half = getActiveBerryHalfExtents(spot)
  const horizontalRadius = Math.max(half.x, half.z) + BERRY_TOUCH_AVATAR_RADIUS
  const dx = pos.x - center.x
  const dz = pos.z - center.z
  if (dx * dx + dz * dz > horizontalRadius * horizontalRadius) return false

  const playerBottom = pos.y
  const playerTop = pos.y + PLAYER_TOUCH_HEIGHT
  const berryBottom = center.y - half.y
  const berryTop = center.y + half.y

  return playerTop >= berryBottom - BERRY_TOUCH_VERTICAL_PADDING && playerBottom <= berryTop + BERRY_TOUCH_VERTICAL_PADDING
}

function setModelCollision(entity: Entity, enabled: boolean, keepPointer = false) {
  if (!GltfContainer.has(entity)) return
  const gltf = GltfContainer.getMutable(entity)
  if (!enabled) {
    gltf.visibleMeshesCollisionMask = 0
    gltf.invisibleMeshesCollisionMask = 0
    return
  }

  const visibleMask = gltf.visibleMeshesCollisionMask ?? 0
  const invisibleMask = gltf.invisibleMeshesCollisionMask ?? 0
  gltf.visibleMeshesCollisionMask = keepPointer
    ? ColliderLayer.CL_POINTER | ColliderLayer.CL_PHYSICS
    : visibleMask | ColliderLayer.CL_PHYSICS
  gltf.invisibleMeshesCollisionMask = invisibleMask | ColliderLayer.CL_PHYSICS
}

function isBerryEntity(entity: Entity) {
  for (const s of spots) {
    if (s.red.entity === entity) return true
  }
  for (const name of STRAWBERRY_NAMES) {
    if (engine.getEntityOrNullByName(name) === entity) return true
  }
  return false
}

function enableSceneModelColliders() {
  for (const [entity] of engine.getEntitiesWith(GltfContainer)) {
    if (collisionReadyModels.has(entity) || isBerryEntity(entity)) continue
    setModelCollision(entity, true)
    collisionReadyModels.add(entity)
  }
}

function getGumdropProfile(src: string, entityName = ''): GumdropProfile | null {
  const identifier = `${src} ${entityName}`.toLowerCase()
  for (const entry of GUMDROP_PROFILES) {
    if (identifier.includes(entry.srcPart)) return entry.profile
  }
  return null
}

function isGumdropIdentifier(src: string, entityName = '') {
  const identifier = `${src} ${entityName}`.toLowerCase()
  return identifier.includes('/gumdrop-') || identifier.includes('models/gumdrop-') || identifier.includes('gumdrop-')
}

function getGumdropCenter(gumdrop: GumdropSpot) {
  const offset = scaleVector(gumdrop.profile.centerOffset, gumdrop.scale)
  return Vector3.create(
    gumdrop.startPosition.x + offset.x,
    gumdrop.startPosition.y + offset.y,
    gumdrop.startPosition.z + offset.z
  )
}

function getGumdropTopY(gumdrop: GumdropSpot) {
  return gumdrop.startPosition.y + gumdrop.profile.topOffset * gumdrop.scale.y
}

function isPlayerTouchingGumdrop(pos: { x: number; y: number; z: number }, gumdrop: GumdropSpot) {
  const center = getGumdropCenter(gumdrop)
  const radius = gumdrop.profile.radius * Math.max(gumdrop.scale.x, gumdrop.scale.z)
  const dx = pos.x - center.x
  const dz = pos.z - center.z
  const topY = getGumdropTopY(gumdrop)

  return (
    dx * dx + dz * dz <= radius * radius &&
    pos.y >= topY - GUMDROP_TOUCH_Y_BELOW &&
    pos.y <= topY + GUMDROP_TOUCH_Y_ABOVE
  )
}

function triggerGumdrop(gumdrop: GumdropSpot) {
  gumdrop.state = 'falling'
  gumdrop.fallTimer = 0
  gumdrop.respawnTimer = GUMDROP_RESPAWN_DELAY
  setModelCollision(gumdrop.entity, false)
}

function resetGumdrop(gumdrop: GumdropSpot) {
  const transform = Transform.getMutable(gumdrop.entity)
  transform.position = Vector3.create(gumdrop.startPosition.x, gumdrop.startPosition.y, gumdrop.startPosition.z)
  VisibilityComponent.createOrReplace(gumdrop.entity, { visible: true })
  setModelCollision(gumdrop.entity, true)
  gumdrop.state = 'ready'
  gumdrop.fallTimer = 0
  gumdrop.respawnTimer = 0
}

function updateGumdrops(dt: number, pos: { x: number; y: number; z: number }) {
  for (const gumdrop of gumdrops) {
    if (!Transform.has(gumdrop.entity)) continue

    if (gumdrop.state === 'ready') {
      if (isPlayerTouchingGumdrop(pos, gumdrop)) triggerGumdrop(gumdrop)
      continue
    }

    if (gumdrop.state === 'falling') {
      gumdrop.fallTimer = Math.min(GUMDROP_FALL_DURATION, gumdrop.fallTimer + dt)
      const t = gumdrop.fallTimer / GUMDROP_FALL_DURATION
      const eased = t * t
      Transform.getMutable(gumdrop.entity).position = Vector3.create(
        gumdrop.startPosition.x,
        gumdrop.startPosition.y - GUMDROP_FALL_DISTANCE * eased,
        gumdrop.startPosition.z
      )

      if (gumdrop.fallTimer >= GUMDROP_FALL_DURATION) {
        VisibilityComponent.createOrReplace(gumdrop.entity, { visible: false })
        gumdrop.state = 'hidden'
      }
      continue
    }

    gumdrop.respawnTimer = Math.max(0, gumdrop.respawnTimer - dt)
    if (gumdrop.respawnTimer <= 0) resetGumdrop(gumdrop)
  }
}

// ── Network helpers ───────────────────────────────────────────────────────────
function getLocalUserId() {
  return myProfile.userId ?? ''
}

function getLocalDisplayName(): string {
  const base = AvatarBase.getOrNull(engine.PlayerEntity)
  if (base?.name) return base.name
  const id = getLocalUserId()
  return id ? id.substring(2, 8).toUpperCase() : 'Player'
}

function updateLocalPresence() {
  const userId = getLocalUserId()
  const displayName = getLocalDisplayName()
  if (!myPresenceEntity || !userId) return
  if (
    lastPresenceUserId === userId &&
    lastPresenceWantsTeam === wantsTeamBattle &&
    lastPresenceChosenTeam === myChosenTeam
  )
    return
  TeamPresence.createOrReplace(myPresenceEntity, {
    userId,
    displayName,
    wantsTeam: wantsTeamBattle,
    token: MY_TOKEN,
    chosenTeam: myChosenTeam
  })
  lastPresenceUserId = userId
  lastPresenceWantsTeam = wantsTeamBattle
  lastPresenceChosenTeam = myChosenTeam
}

function initializeSyncedGameplay() {
  if (syncedGameplayReady || !myProfile.networkId || spots.length === 0) return

  matchStateEntity = engine.addEntity()
  syncEntity(matchStateEntity, [MatchState.componentId], SyncIds.MatchState)

  soloLeaderboardEntity = engine.addEntity()
  syncEntity(soloLeaderboardEntity, [SoloLeaderboardState.componentId], SyncIds.SoloLeaderboard)

  spots.forEach((spot, idx) => {
    const rs = engine.addEntity()
    syncEntity(rs, [BerryState.componentId], SyncIds.RedBerry0 + idx)
    spot.red.stateEntity = rs

    const bs = engine.addEntity()
    syncEntity(bs, [BerryState.componentId], SyncIds.BlueBerry0 + idx)
    spot.blue.stateEntity = bs
  })

  myPresenceEntity = engine.addEntity()
  TeamPresence.create(myPresenceEntity, {
    userId: getLocalUserId(),
    displayName: getLocalDisplayName(),
    wantsTeam: wantsTeamBattle,
    token: MY_TOKEN,
    chosenTeam: myChosenTeam
  })
  syncEntity(myPresenceEntity, [TeamPresence.componentId])

  syncedGameplayReady = true
  updateLocalPresence()
}

function ensureSyncedDefaults() {
  if (syncedDefaultsReady || !matchStateEntity || !soloLeaderboardEntity) return

  if (!MatchState.getOrNull(matchStateEntity)) {
    MatchState.create(matchStateEntity, {
      phase: MatchPhaseCode.Waiting,
      countdownStart: 0,
      gameStart: 0,
      duration: TEAM_COUNTDOWN,
      redPlayers: [],
      bluePlayers: [],
      version: 0,
      lobbyTimer: 0,
      hostTime: 0,
      hasWarnedUnbalanced: false,
      knownPlayers: [],
      lobbyPlayers: []
    })
  }

  if (!SoloLeaderboardState.getOrNull(soloLeaderboardEntity)) {
    SoloLeaderboardState.create(soloLeaderboardEntity, {
      entries: [],
      version: 0
    })
  }

  spots.forEach((spot, idx) => {
    if (spot.red.stateEntity && !BerryState.getOrNull(spot.red.stateEntity))
      BerryState.create(spot.red.stateEntity, {
        team: TeamCode.Red,
        spot: idx,
        collected: false,
        collectedUntil: 0,
        catches: 0
      })
    if (spot.blue.stateEntity && !BerryState.getOrNull(spot.blue.stateEntity))
      BerryState.create(spot.blue.stateEntity, {
        team: TeamCode.Blue,
        spot: idx,
        collected: false,
        collectedUntil: 0,
        catches: 0
      })
  })

  syncedDefaultsReady = true
}

function serializeLeaderboardEntry(entry: LeaderboardEntry): string {
  const safeName = (entry.name ?? 'Player').replace(/\|/g, ' ').substring(0, 24)
  const safeUserId = (entry.userId ?? '').replace(/\|/g, '')
  return `${entry.time.toFixed(3)}|${safeName}|${safeUserId}`
}

function parseLeaderboardEntry(value: string): LeaderboardEntry | null {
  const [timeStr, name, userId] = value.split('|')
  const time = Number(timeStr)
  if (!Number.isFinite(time)) return null
  return { time, name: name || 'Player', userId: userId || undefined }
}

function sortLeaderboard(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  return entries
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => a.time - b.time)
    .slice(0, LEADERBOARD_MAX)
}

function getGlobalSoloLeaderboard(): LeaderboardEntry[] {
  if (!soloLeaderboardEntity) return leaderboard.slice()
  const state = SoloLeaderboardState.getOrNull(soloLeaderboardEntity)
  if (!state) return leaderboard.slice()
  return sortLeaderboard(state.entries.map(parseLeaderboardEntry).filter((entry): entry is LeaderboardEntry => !!entry))
}

function refreshSoloLeaderboardFromSync() {
  const synced = getGlobalSoloLeaderboard()
  leaderboard.length = 0
  leaderboard.push(...synced)
}

function addGlobalSoloLeaderboardEntry(entry: LeaderboardEntry) {
  if (soloLeaderboardEntity) {
    const state = SoloLeaderboardState.getMutableOrNull(soloLeaderboardEntity)
    if (state) {
      const merged = sortLeaderboard([
        ...state.entries.map(parseLeaderboardEntry).filter((item): item is LeaderboardEntry => !!item),
        entry
      ])
      state.entries = merged.map(serializeLeaderboardEntry)
      state.version += 1
      leaderboard.length = 0
      leaderboard.push(...merged)
      return
    }
  }

  leaderboard.push(entry)
  leaderboard.sort((a, z) => a.time - z.time)
  if (leaderboard.length > LEADERBOARD_MAX) leaderboard.length = LEADERBOARD_MAX
}

function getTeamRoster(): LobbyPlayer[] {
  const players = new Map<string, LobbyPlayer>()
  for (const [, p] of engine.getEntitiesWith(TeamPresence)) {
    if (!p.wantsTeam || !p.userId) continue
    const cur = players.get(p.userId)
    if (!cur || p.token < cur.token) players.set(p.userId, { userId: p.userId, token: p.token })
  }
  return Array.from(players.values()).sort((a, b) =>
    a.token !== b.token ? a.token - b.token : a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0
  )
}

type PresenceInfo = { userId: string; displayName: string; chosenTeam: number; token: number; wantsTeam: boolean }
function getTeamPresenceList(): PresenceInfo[] {
  const players = new Map<string, PresenceInfo>()
  for (const [, p] of engine.getEntitiesWith(TeamPresence)) {
    if (!p.wantsTeam || !p.userId) continue
    const cur = players.get(p.userId)
    if (!cur || p.token < cur.token) {
      players.set(p.userId, {
        userId: p.userId,
        displayName: p.displayName || p.userId.substring(2, 8).toUpperCase(),
        chosenTeam: p.chosenTeam ?? 0,
        token: Number(p.token),
        wantsTeam: p.wantsTeam ?? false
      })
    }
  }
  return Array.from(players.values())
}

function getLobbyPlayersList(match: ReturnType<typeof MatchState.get>): PresenceInfo[] {
  if (!match.lobbyPlayers || match.lobbyPlayers.length === 0) {
    return getTeamPresenceList()
  }
  return match.lobbyPlayers.map((str) => {
    const [userId, displayName, chosenTeamStr, wantsTeamStr, tokenStr] = str.split('|')
    return {
      userId,
      displayName: displayName || userId.substring(2, 8).toUpperCase(),
      chosenTeam: parseInt(chosenTeamStr) || 0,
      wantsTeam: wantsTeamStr === 'true',
      token: parseInt(tokenStr) || 0
    } as PresenceInfo
  })
}

function getTeamFromMatch(match: ReturnType<typeof MatchState.get>): Team | null {
  const id = getLocalUserId()
  if (!id) return null
  if (match.redPlayers.includes(id)) return 'red'
  if (match.bluePlayers.includes(id)) return 'blue'
  return null
}

function isLobbyHost(roster: LobbyPlayer[]) {
  const id = getLocalUserId()
  return !!id && roster.length > 0 && roster[0].userId === id
}

function resetSyncedBerryStates() {
  for (const spot of spots) {
    for (const slot of [spot.red, spot.blue] as TeamSlot[]) {
      if (!slot.stateEntity) continue
      const s = BerryState.getMutableOrNull(slot.stateEntity)
      if (!s) continue
      s.collected = false
      s.collectedUntil = 0
      s.catches = 0
      slot.collected = false
      slot.wasInside = false
      slot.respawnTimer = 0
    }
  }
}

function startSyncedCountdown(match: ReturnType<typeof MatchState.getMutable>) {
  const presences = getLobbyPlayersList(match)
  let red = presences.filter((p) => p.chosenTeam === 1).map((p) => p.userId)
  let blue = presences.filter((p) => p.chosenTeam === 2).map((p) => p.userId)

  if (red.length === 0 || blue.length === 0) return

  const diff = red.length - blue.length
  if (Math.abs(diff) > 1) {
    if (diff > 1) {
      while (red.length - blue.length > 1) {
        const p = red.pop()
        if (p) blue.push(p)
      }
    } else {
      while (blue.length - red.length > 1) {
        const p = blue.pop()
        if (p) red.push(p)
      }
    }
    console.log('[AutoBalancer] Balanced teams on match start.')
  }

  resetSyncedBerryStates()
  match.phase = MatchPhaseCode.Countdown
  match.countdownStart = Date.now()
  match.gameStart = 0
  match.duration = TEAM_COUNTDOWN
  match.redPlayers = red
  match.bluePlayers = blue
  match.lobbyTimer = 0
  match.version += 1
  match.hostTime = Date.now()
  match.hasWarnedUnbalanced = false
}

// Both teams have ≥ 1 player and nobody is unassigned.
// Does NOT require equal team sizes — uneven matches are allowed with a warning.
function teamsCanStart(presences: PresenceInfo[]): boolean {
  const red = presences.filter((p) => p.chosenTeam === 1)
  const blue = presences.filter((p) => p.chosenTeam === 2)
  const unassigned = presences.filter((p) => p.chosenTeam === 0)
  return red.length >= 1 && blue.length >= 1 && unassigned.length === 0
}

function getSyncedScores(): Record<Team, number> {
  const s: Record<Team, number> = { red: 0, blue: 0 }
  for (const spot of spots) {
    if (spot.red.stateEntity) s.red += BerryState.getOrNull(spot.red.stateEntity)?.catches ?? 0
    if (spot.blue.stateEntity) s.blue += BerryState.getOrNull(spot.blue.stateEntity)?.catches ?? 0
  }
  return s
}

function syncBerryVisibility(now: number) {
  for (const spot of spots) {
    for (const [team, slot] of [
      ['red', spot.red],
      ['blue', spot.blue]
    ] as [Team, TeamSlot][]) {
      if (!slot.stateEntity) continue
      const s = BerryState.getMutableOrNull(slot.stateEntity)
      if (!s) continue

      if (s.collected && s.collectedUntil > 0 && now >= s.collectedUntil) {
        s.collected = false
        s.collectedUntil = 0
      }
      const isCollected = s.collected && now < s.collectedUntil
      slot.collected = isCollected
    }
  }
}

// ── Lobby / Camera helpers ────────────────────────────────────────────────────
function enterLobby() {
  gameMode = 'lobby'
  wantsTeamBattle = false
  hideAllBerries()
  updateLocalPresence()
  updateLobbyState()

  // Unlock movement (allow players to rearrange freely)
  InputModifier.deleteFrom(engine.PlayerEntity)

  // Activate cinematic camera
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: cinematicCam })

  // Teleport to lobby position
  void movePlayerTo({ newRelativePosition: Vector3.create(LOBBY_X, LOBBY_Y, LOBBY_Z) })
}

function exitLobby() {
  // Deactivate cinematic camera — return to player's own camera
  MainCamera.deleteFrom(engine.CameraEntity)

  // Unlock movement
  InputModifier.deleteFrom(engine.PlayerEntity)
}

function closeFinish() {
  exitLobby()
  gameMode = 'idle'
  teamPhase = 'idle'
  shownFinishForVersion = -1
  localTeam = null
  wantsTeamBattle = false
  updateLocalPresence()
  hideAllBerries()
}

// ── Mode management ───────────────────────────────────────────────────────────
function selectMode(mode: 'solo' | 'team') {
  // exitLobby is safe to call from any state — it just removes the camera
  // override and input lock that may have been set by either enterLobby()
  // or finishTeam().
  exitLobby()
  hideAllBerries()

  if (mode === 'solo') {
    // Reset team state fully so next team match starts clean
    if (teamPhase === 'finished') {
      teamPhase = 'idle'
      localTeam = null
      shownFinishForVersion = -1
    }
    gameMode = 'solo'
    soloPhase = 'idle'
    soloTimer = 0
    soloCountdownTimer = 0
    wantsTeamBattle = false
    updateLocalPresence()
    startSoloCountdown()
  } else {
    // Team lobby: player enters the team picker.
    // They must explicitly pick Red or Blue before the match can start.
    gameMode = 'team'
    teamPhase = 'waiting'
    localTeam = null
    myChosenTeam = 0 // unassigned — must pick in lobby
    wantsTeamBattle = true
    lastPresenceChosenTeam = -1 // force re-broadcast
    updateLocalPresence()
    updateTeamState('waiting', TEAM_COUNTDOWN, { red: 0, blue: 0 }, null)
  }
}

function goToLobby() {
  // Called by "Back to Menu" / "X" / "Change Mode"
  teamPhase = 'idle'
  localTeam = null
  myChosenTeam = 0
  shownFinishForVersion = -1
  soloPhase = 'idle'
  soloTimer = 0
  soloCountdownTimer = 0
  wantsTeamBattle = false
  lastPresenceChosenTeam = -1
  updateLocalPresence()
  enterLobby()
}

function joinTeam(team: 1 | 2) {
  myChosenTeam = team
  lastPresenceChosenTeam = -1
  updateLocalPresence()
}

function forceStart() {
  if (!matchStateEntity) return
  const match = MatchState.getMutableOrNull(matchStateEntity)
  if (!match) return
  // Allow force-start from Waiting or Finished (when opted in for rematch)
  if (match.phase !== MatchPhaseCode.Waiting && match.phase !== MatchPhaseCode.Finished) return
  const roster = getTeamRoster()
  if (!isLobbyHost(roster)) return
  startSyncedCountdown(match)
}

// ── Solo mode ─────────────────────────────────────────────────────────────────
function startSoloCountdown() {
  soloPhase = 'countdown'
  soloCountdownTimer = SOLO_PREGAME_DURATION
  soloTimer = 0
  for (const s of spots) {
    s.red.collected = false
    s.red.wasInside = false
    s.red.respawnTimer = 0
    s.blue.collected = false
    s.blue.wasInside = false
    s.blue.respawnTimer = 0
  }
  updateSoloState('countdown', soloCountdownTimer, leaderboard)
}

function startSolo() {
  soloPhase = 'playing'
  soloTimer = 0
  setUiTimer(soloTimer)
  for (const s of spots) {
    s.red.collected = false
    s.red.wasInside = false
    s.red.respawnTimer = 0
    s.blue.collected = false
    s.blue.wasInside = false
    s.blue.respawnTimer = 0
  }
  updateSoloState('playing', spots.length, leaderboard)
}

function finishSolo() {
  soloPhase = 'finished'
  addGlobalSoloLeaderboardEntry({
    time: soloTimer,
    name: getLocalDisplayName(),
    userId: getLocalUserId()
  })
  setUiTimer(soloTimer)
  updateSoloState('finished', 0, leaderboard)
}

function collectSolo(s: BerrySpot) {
  if (s.red.collected || soloPhase !== 'playing') return
  s.red.collected = true
  showSlot(s.red, false)
  AudioSource.createOrReplace(soundEntity, { audioClipUrl: COLLECT_SOUND, playing: true, loop: false, volume: 1 })
  showCollectPopup(null)
  const left = soloRemaining()
  updateSoloState('playing', left, leaderboard)
  if (left === 0) finishSolo()
}

// ── Team mode ─────────────────────────────────────────────────────────────────
function finishTeam(version: number) {
  if (shownFinishForVersion === version) return // already shown for this match
  shownFinishForVersion = version
  teamPhase = 'finished'
  teamScores = getSyncedScores()
  hideAllBerries()
  wantsTeamBattle = false
  updateLocalPresence()

  // TeleActivate cinematic camera + lock movement for the result screen
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableAll: true })
  })
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: cinematicCam })

  const winner: Team | 'draw' =
    teamScores.red > teamScores.blue ? 'red' : teamScores.blue > teamScores.red ? 'blue' : 'draw'
  updateTeamState('finished', 0, teamScores, localTeam, winner)
}

function collectTeam(s: BerrySpot, team: Team, hostNow: number) {
  const slot = team === 'red' ? s.red : s.blue
  if (!slot.stateEntity) return

  const state = BerryState.getMutableOrNull(slot.stateEntity)
  if (!state) return
  if (state.collected && hostNow < state.collectedUntil) return

  state.collected = true
  state.collectedUntil = hostNow + BERRY_RESPAWN_DELAY * 1000
  state.catches += 1

  slot.collected = true
  slot.respawnTimer = BERRY_RESPAWN_DELAY
  teamScores = getSyncedScores()
  AudioSource.createOrReplace(soundEntity, { audioClipUrl: COLLECT_SOUND, playing: true, loop: false, volume: 1 })
  showCollectPopup(team)
  updateTeamState('playing', teamTimer, teamScores, localTeam)
}

// ── Main ──────────────────────────────────────────────────────────────────────
let soundEntity: Entity

export function main() {
  setupUi()
  setModeSelectCallback(selectMode)
  setChangeModeCallback(goToLobby)
  setCloseLobbyCallback(closeLobby)
  setCloseFinishCallback(closeFinish)
  setJoinTeamCallback(joinTeam)
  setForceStartCallback(forceStart)

  soundEntity = engine.addEntity()

  // ── Cinematic camera ──────────────────────────────────────────────────────
  cinematicCam = engine.addEntity()
  Transform.create(cinematicCam, {
    position: Vector3.create(8, 4, 2),
    rotation: Quaternion.fromEulerDegrees(-18, 0, 0)
  })
  VirtualCamera.create(cinematicCam, {
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(1.2) }
  })

  // Berry spots are initialized lazily inside ensureSpotsInitialized system call
  // to prevent race conditions during composite async loading.

  // ── Kick off in lobby ─────────────────────────────────────────────────────
  enterLobby()

  // ── Lazy Spots Initializer ──────────────────────────────────────────────────
  let spotsInitialized = false
  let loggedGumdropCount = 0

  function ensureSpotsInitialized() {
    if (spotsInitialized) return
    if (spots.length > 0) {
      spotsInitialized = true
      return
    }

    for (const name of STRAWBERRY_NAMES) {
      const redEntity = engine.getEntityOrNullByName(name)
      if (!redEntity) {
        continue
      }

      if (!GltfContainer.has(redEntity) || !Transform.has(redEntity)) {
        continue
      }

      const gltf = GltfContainer.getMutable(redEntity)
      gltf.visibleMeshesCollisionMask = ColliderLayer.CL_POINTER
      gltf.invisibleMeshesCollisionMask = 0

      const tf = Transform.getOrNull(redEntity)
      const bx = tf?.position.x ?? 0
      const by = tf?.position.y ?? 1
      const bz = tf?.position.z ?? 0
      const bScale = tf ? Vector3.create(tf.scale.x, tf.scale.y, tf.scale.z) : Vector3.create(1, 1, 1)

      Transform.getMutable(redEntity).scale = scaledBerry(bScale, STRAWBERRY_SCALE_MULTIPLIER)

      spots.push({
        x: bx,
        y: by,
        z: bz,
        baseScale: bScale,
        red: { entity: redEntity, collected: false, wasInside: false, respawnTimer: 0, stateEntity: null },
        blue: { entity: redEntity, collected: false, wasInside: false, respawnTimer: 0, stateEntity: null }
      })
    }

    if (spots.length > 0) {
      spotsInitialized = true
      console.log('[Candy Rush] Successfully lazily initialized', spots.length, 'berry spots!')
    }
  }

  function ensureGumdropsInitialized() {
    for (const [entity, gltf, transform] of engine.getEntitiesWith(GltfContainer, Transform)) {
      if (gumdrops.some((g) => g.entity === entity)) continue
      const entityName = Name.getOrNull(entity)?.value ?? ''
      if (!isGumdropIdentifier(gltf.src, entityName)) continue
      const profile = getGumdropProfile(gltf.src, entityName)
      if (!profile) continue

      gumdrops.push({
        entity,
        startPosition: Vector3.create(transform.position.x, transform.position.y, transform.position.z),
        scale: Vector3.create(transform.scale.x, transform.scale.y, transform.scale.z),
        profile,
        state: 'ready',
        fallTimer: 0,
        respawnTimer: 0
      })

      VisibilityComponent.createOrReplace(entity, { visible: true })
      setModelCollision(entity, true)
      collisionReadyModels.add(entity)
    }

    if (gumdrops.length > loggedGumdropCount) {
      loggedGumdropCount = gumdrops.length
      console.log('[Candy Rush] Initialized', gumdrops.length, 'gumdrops!')
    }
  }

  // ── Main system ───────────────────────────────────────────────────────────
  engine.addSystem((dt: number) => {
    ensureSpotsInitialized()
    ensureGumdropsInitialized()
    enableSceneModelColliders()
    initializeSyncedGameplay()

    const syncedThisFrame = isStateSyncronized()
    if (syncedThisFrame && !wasStateSynchronizedLastFrame) {
      hasCalibratedOffset = false
      lastSeenHostTime = 0
      hostClockOffset = 0
    }
    wasStateSynchronizedLastFrame = syncedThisFrame

    if (syncedThisFrame && syncedGameplayReady) {
      ensureSyncedDefaults()
      refreshSoloLeaderboardFromSync()
    }

    const pos = getPlayerPosition()
    updateGumdrops(dt, pos)

    for (const s of spots) {
      updateBerryRepresentation(s)
    }

    tickUi(dt)

    // ── Lobby (idle) ─────────────────────────────────────────────────────────
    if (gameMode === 'lobby' || gameMode === 'idle') return

    // ── Solo countdown ───────────────────────────────────────────────────────
    if (gameMode === 'solo') {
      if (soloPhase === 'countdown') {
        soloCountdownTimer = Math.max(0, soloCountdownTimer - dt)
        updateSoloState('countdown', soloCountdownTimer, leaderboard)
        if (soloCountdownTimer <= 0) startSolo()
      }

      if (soloPhase === 'playing') {
        soloTimer += dt
        setUiTimer(soloTimer)
        for (const s of spots) {
          if (s.red.collected) continue
          const touchingBerry = isPlayerTouchingBerry(pos, s)
          if (touchingBerry && !s.red.wasInside) {
            s.red.wasInside = true
            collectSolo(s)
          } else if (!touchingBerry) s.red.wasInside = false
        }

      }

      return
    }

    // ── Team ─────────────────────────────────────────────────────────────────
    if (gameMode === 'team') {
      updateLocalPresence()

      if (!syncedGameplayReady || !matchStateEntity || !isStateSyncronized()) {
        hideAllBerries()
        return
      }

      ensureSyncedDefaults()
      const rawMatch = MatchState.getOrNull(matchStateEntity)
      if (!rawMatch) {
        hideAllBerries()
        return
      }

      const now = Date.now()
      const roster = getTeamRoster()
      const host = isLobbyHost(roster)
      const match = host ? MatchState.getMutable(matchStateEntity) : (MatchState.get(matchStateEntity) as any)

      if (host) {
        const localPresences = getTeamPresenceList()
        const serialized = localPresences.map(
          (p) => p.userId + '|' + p.displayName + '|' + p.chosenTeam + '|' + p.wantsTeam + '|' + p.token
        )
        let changed = false
        if (serialized.length !== match.lobbyPlayers.length) {
          changed = true
        } else {
          for (let i = 0; i < serialized.length; i++) {
            if (serialized[i] !== match.lobbyPlayers[i]) {
              changed = true
              break
            }
          }
        }
        if (changed) {
          match.lobbyPlayers = serialized
        }

        if (now - lastHostTimeUpdate >= 2000) {
          match.hostTime = now
          lastHostTimeUpdate = now
        }
      }

      if (match.hostTime > 0 && match.hostTime !== lastSeenHostTime) {
        hostClockOffset = match.hostTime - now
        lastSeenHostTime = match.hostTime
        hasCalibratedOffset = true
      }

      if (!hasCalibratedOffset) {
        if (match.countdownStart > 0) {
          hostClockOffset = match.countdownStart - now
          hasCalibratedOffset = true
        } else if (match.lobbyTimer > 0) {
          hostClockOffset = match.lobbyTimer - LOBBY_START_DELAY_MS - now
          hasCalibratedOffset = true
        }
      }

      const hostNow = now + hostClockOffset

      // ── Waiting: lobby management ─────────────────────────────────────────────
      if (match.phase === MatchPhaseCode.Waiting) {
        const presences = getLobbyPlayersList(match)
        const myId = getLocalUserId()
        const canStart = teamsCanStart(presences)
        const host = isLobbyHost(roster)

        if (host) {
          const currentIds = presences.map((p) => p.userId)
          let newPlayerJoined = false
          const updatedKnownPlayers = [...match.knownPlayers]

          for (const id of currentIds) {
            if (!updatedKnownPlayers.includes(id)) {
              updatedKnownPlayers.push(id)
              newPlayerJoined = true
            }
          }

          // Clean up players who left the lobby
          const filteredKnownPlayers = updatedKnownPlayers.filter((id) => currentIds.includes(id))

          // Compare updated list with existing list
          let knownPlayersChanged = false
          if (filteredKnownPlayers.length !== match.knownPlayers.length) {
            knownPlayersChanged = true
          } else {
            for (let i = 0; i < filteredKnownPlayers.length; i++) {
              if (filteredKnownPlayers[i] !== match.knownPlayers[i]) {
                knownPlayersChanged = true
                break
              }
            }
          }

          if (knownPlayersChanged) {
            match.knownPlayers = filteredKnownPlayers
          }

          if (canStart) {
            const red = presences.filter((p) => p.chosenTeam === 1)
            const blue = presences.filter((p) => p.chosenTeam === 2)
            const totalReady = red.length + blue.length

            if (match.lobbyTimer === 0) {
              match.lobbyTimer = now + LOBBY_START_DELAY_MS
              lastTotalReadyOnHost = totalReady
            } else {
              // If a new player joined, bump timer by 30 seconds
              if (newPlayerJoined) {
                match.lobbyTimer += 30000
                console.log('[Lobby] New player joined! Adding 30s to countdown.')
              }

              // If total ready increased, also bump by 30 seconds
              if (totalReady > lastTotalReadyOnHost) {
                match.lobbyTimer += 30000
                console.log('[Lobby] Player ready count increased! Adding 30s.')
              }
              lastTotalReadyOnHost = totalReady
            }

            if (match.lobbyTimer > 0 && hostNow >= match.lobbyTimer) {
              const pRed = presences.filter((p) => p.chosenTeam === 1)
              const pBlue = presences.filter((p) => p.chosenTeam === 2)
              const teamDiff = Math.abs(pRed.length - pBlue.length)

              if (teamDiff > 1 && !match.hasWarnedUnbalanced) {
                match.lobbyTimer = now + 30000
                match.hasWarnedUnbalanced = true
                console.log('[Lobby] Timer expired unbalanced. Giving 30s warning extension.')
              } else {
                startSyncedCountdown(match)
              }
            }
          } else {
            // When not fully ready to start (e.g., someone is unassigned or a team is empty):
            // We do NOT reset the timer if it's already active (running), giving players time to decide!
            if (match.lobbyTimer > 0) {
              if (newPlayerJoined) {
                match.lobbyTimer += 30000
                console.log('[Lobby] New player joined while teams not ready! Adding 30s.')
              }
            } else {
              match.lobbyTimer = 0
              match.hasWarnedUnbalanced = false
              lastTotalReadyOnHost = 0
            }
          }
        }

        const timeLeft = match.lobbyTimer > 0 ? Math.max(0, (match.lobbyTimer - hostNow) / 1000) : -1

        updateLobbyTeams(presences, myId, timeLeft, host, canStart, match.hasWarnedUnbalanced)
      }

      // ── Finished ─────────────────────────────────────────────────────────────
      if (match.phase === MatchPhaseCode.Finished) {
        hideAllBerries()

        // Show result screen the first time we see this match version
        if (shownFinishForVersion !== match.version) {
          const myTeam = getTeamFromMatch(match)
          if (myTeam) localTeam = myTeam
          finishTeam(match.version)
          return
        }

        // Still on result screen and haven't opted in yet
        if (!wantsTeamBattle) return

        // This player opted in — show team lobby and wait for others to also opt in
        // The Waiting phase handles the rest once the match resets
        if (host) {
          // Reset match state back to Waiting so the new lobby countdown runs!
          match.phase = MatchPhaseCode.Waiting
          match.countdownStart = 0
          match.gameStart = 0
          match.lobbyTimer = 0
          match.redPlayers = []
          match.bluePlayers = []
          match.hasWarnedUnbalanced = false
          match.knownPlayers = []
          resetSyncedBerryStates()
        } else {
          const presences = getLobbyPlayersList(match)
          updateLobbyTeams(presences, getLocalUserId(), -1, host, teamsCanStart(presences))
          teamPhase = 'waiting'
          updateTeamState('waiting', TEAM_COUNTDOWN, getSyncedScores(), null)
          return
        }
      }

      // Re-read after potential startSyncedCountdown mutation
      const syncedTeam = getTeamFromMatch(match)
      if (syncedTeam) {
        localTeam = syncedTeam
      } else if (myChosenTeam === 1) {
        localTeam = 'red'
      } else if (myChosenTeam === 2) {
        localTeam = 'blue'
      } else {
        localTeam = null
      }
      teamScores = getSyncedScores()

      // ── Countdown ────────────────────────────────────────────────────────────
      if (match.phase === MatchPhaseCode.Countdown) {
        const elapsedMs = Math.max(0, hostNow - match.countdownStart)
        pregameTimer = Math.max(0, TEAM_PREGAME_DURATION - elapsedMs / 1000)

        if (host && elapsedMs >= TEAM_PREGAME_DURATION_MS) {
          match.phase = MatchPhaseCode.Playing
          match.gameStart = match.countdownStart + TEAM_PREGAME_DURATION_MS
        }

        if (localTeam) {
          teamPhase = 'countdown'
          hideAllBerries()
          updateTeamState('countdown', pregameTimer, teamScores, localTeam)
        } else {
          hideAllBerries()
          teamPhase = 'waiting'
          const presences = getLobbyPlayersList(match)
          updateLobbyTeams(presences, getLocalUserId(), -1, host, false)
        }
        return
      }

      // ── Playing ──────────────────────────────────────────────────────────────
      if (match.phase === MatchPhaseCode.Playing) {
        teamTimer = Math.max(0, match.duration - (hostNow - match.gameStart) / 1000)
        setUiTimer(teamTimer)
        syncBerryVisibility(hostNow)

        if (localTeam) {
          teamPhase = 'playing'

          for (const s of spots) {
            const slot = localTeam === 'red' ? s.red : s.blue
            if (slot.collected) continue
            const touchingBerry = isPlayerTouchingBerry(pos, s)
            if (touchingBerry && !slot.wasInside) {
              slot.wasInside = true
              collectTeam(s, localTeam, hostNow)
            } else if (!touchingBerry) slot.wasInside = false
          }

          updateTeamState('playing', teamTimer, teamScores, localTeam)
        } else {
          hideAllBerries()
          teamPhase = 'waiting'
          const presences = getLobbyPlayersList(match)
          updateLobbyTeams(presences, getLocalUserId(), -1, host, false)
        }

        if (host && teamTimer <= 0) {
          match.phase = MatchPhaseCode.Finished
        }
        return
      }

      // ── Waiting (no match yet) ────────────────────────────────────────────
      if (wantsTeamBattle) {
        teamPhase = 'waiting'
        hideAllBerries()
        updateTeamState('waiting', TEAM_COUNTDOWN, teamScores, null)
      } else {
        hideAllBerries()
        if (shownFinishForVersion === match.version) {
          teamPhase = 'finished'
        } else {
          teamPhase = 'waiting'
          updateTeamState('waiting', TEAM_COUNTDOWN, teamScores, null)
        }
      }
    }
  })
}
