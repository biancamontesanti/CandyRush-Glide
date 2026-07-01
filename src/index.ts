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
  Name,
  TriggerArea,
  triggerAreaEventsSystem,
  AssetLoad
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
const MUSIC_SOUND = 'assets/sounds/musicthemeloop.mp3'
const COLLECT_SOUND = 'assets/sounds/collected.mp3'
const COUNTDOWN_SOUND = 'assets/sounds/countdown3sec.mp3'
const VICTORY_SOUND = 'assets/sounds/victory.mp3'
const LOST_SOUND = 'assets/sounds/lost.mp3'
const DRAW_SOUND = 'assets/sounds/draw.mp3'
const SOUND_ASSETS = [MUSIC_SOUND, COLLECT_SOUND, COUNTDOWN_SOUND, VICTORY_SOUND, LOST_SOUND, DRAW_SOUND]
const GREEN_BEAR_SRC = 'assets/scene/Models/beargreen/beargreen.glb'
const PURPLE_BEAR_SRC = 'assets/scene/Models/bearpurple/bearpurple.glb'
const STRAWBERRY_SPOT_SRC = 'assets/scene/Models/STRAWBERRY/STRAWBERRY.glb'
const STRIPES_SRC = 'assets/scene/Models/stripes/stripes.glb'
const JELLO_SRC = 'assets/scene/Models/jello/jello.glb'
const JELLPIECE_SRC = 'assets/scene/Models/jellpiece/jellpiece.glb'
const JELLOPIECE_SRC = 'assets/scene/Models/jellopiece/jellopiece.glb'
const RING_SRC_PART = '/ring/'

const TEAM_COUNTDOWN = 300
const BERRY_RESPAWN_DELAY = 20
const SOLO_PREGAME_DURATION = 4.99
const TEAM_ASSIGN_INTRO_DURATION = 3
const TEAM_READY_INTRO_DURATION = 3
const TEAM_COUNTDOWN_DURATION = 4
const COUNTDOWN_SOUND_START_DELAY = 1.13
const COUNTDOWN_SOUND_TRIGGER_REMAINING = Math.max(0, TEAM_COUNTDOWN_DURATION - COUNTDOWN_SOUND_START_DELAY)
const TEAM_PREGAME_DURATION = TEAM_ASSIGN_INTRO_DURATION + TEAM_READY_INTRO_DURATION + TEAM_COUNTDOWN_DURATION
const TEAM_PREGAME_DURATION_MS = Math.ceil(TEAM_PREGAME_DURATION * 1000)
// How long to wait after teams are ready before the match auto-starts.
// Players can still switch teams or new players can join during this window.
const LOBBY_START_DELAY_MS = 30_000 // 30 seconds

const GREEN_BEAR_SCALE_MULTIPLIER = 0.8
const PURPLE_BEAR_SCALE_MULTIPLIER = 0.8
const GREEN_BEAR_CENTER_OFFSET = Vector3.create(-0.024, 0.026, 0.065)
const PURPLE_BEAR_CENTER_OFFSET = Vector3.create(-0.032, -0.003, 0.089)
const BEAR_HALF_EXTENTS = Vector3.create(1.2063, 1.6856, 0.8195)
const PLAYER_TOUCH_HEIGHT = 1.9
const BERRY_TOUCH_AVATAR_RADIUS = 0.75
const BERRY_TOUCH_VERTICAL_PADDING = 1.2
const BERRY_TRIGGER_EXTRA_RADIUS = 0.35

// Lobby spawn position — center of parcel, just inside
const LOBBY_X = 8,
  LOBBY_Y = 0,
  LOBBY_Z = 8

const STRAWBERRY_NAMES = [
  'STRAWBERRY.glb',
  'STRAWBERRY.glb_2',
  'STRAWBERRY.glb_3',
  'STRAWBERRY.glb_4',
  'STRAWBERRY.glb_5',
  'STRAWBERRY.glb_6',
  'STRAWBERRY.glb_7'
]
const BERRY_SPOT_TARGET_COUNT = 6
const RING_ROTATION_SPEED_DEGREES = 70
const GUMDROP_FALL_DURATION = 0.45
const GUMDROP_FALL_DELAY = 2
const GUMDROP_FALL_DISTANCE = 3.2
const GUMDROP_RESPAWN_DELAY = 3
const GUMDROP_TOUCH_RADIUS_PADDING = 0.55
const GUMDROP_TOUCH_Y_BELOW = 0.45
const GUMDROP_TOUCH_Y_ABOVE = 1.15
const GUMDROP_TRIGGER_HEIGHT = GUMDROP_TOUCH_Y_BELOW + GUMDROP_TOUCH_Y_ABOVE
const GUMDROP_SHAKE_AMPLITUDE = 0.08
const GUMDROP_SHAKE_SPEED = 34
const STRIPE_STICKY_VERTICAL_BELOW = 1.4
const STRIPE_STICKY_VERTICAL_ABOVE = 3
const STRIPE_STICKY_HORIZONTAL_PADDING = 1.5
const STRIPE_GLUE_VERTICAL_PADDING_BELOW = 2.2
const STRIPE_GLUE_VERTICAL_PADDING_ABOVE = 3.2
const STRIPE_GLUE_HORIZONTAL_PADDING = 3
const STRIPE_GLUE_HOLD_DURATION = 0.18
const STRIPE_SLOW_DRAG = 0.28
const STRIPE_SLOW_STEP_DURATION = 0.08
const JELLO_BOUNCE_VERTICAL_BELOW = 0.55
const JELLO_BOUNCE_VERTICAL_ABOVE = 1.25
const JELLO_BOUNCE_HORIZONTAL_PADDING = 1.2
const JELLO_BOUNCE_COOLDOWN = 0.6
const JELLO_BOUNCE_DURATION = 0.5
const JELLO_SUPER_JUMP_HEIGHT = 5.5
const JELLO_SUPER_JUMP_ASCENT_DURATION = 1
const JELLO_SUPER_JUMP_STEP_DURATION = 0.1

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
  triggerEntity: Entity
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
  triggerEntity: Entity
  state: 'ready' | 'armed' | 'falling' | 'hidden'
  delayTimer: number
  fallTimer: number
  respawnTimer: number
}

type RingSpot = {
  entity: Entity
  basePosition: { x: number; y: number; z: number }
  baseRotation: { x: number; y: number; z: number; w: number }
  angle: number
}

type SurfaceProfile = {
  localCenter: { x: number; y: number; z: number }
  halfExtents: { x: number; y: number; z: number }
}

type CandySurface = {
  entity: Entity
  basePosition: { x: number; y: number; z: number }
  baseRotation: { x: number; y: number; z: number; w: number }
  baseScale: { x: number; y: number; z: number }
  profile: SurfaceProfile
}

type JelloSurface = CandySurface & {
  bounceTimer: number
  cooldownTimer: number
  wasPlayerOnTop: boolean
}

type ActiveJelloJump = {
  startY: number
  elapsed: number
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
const berrySpotMarkers = new Set<Entity>()
const gumdrops: GumdropSpot[] = []
const rings: RingSpot[] = []
const stickyStripes: CandySurface[] = []
const jellos: JelloSurface[] = []
const collisionReadyModels = new Set<Entity>()
const leaderboard: LeaderboardEntry[] = []
const LEADERBOARD_MAX = 5

// Cinematic camera entity (created once in main)
let cinematicCam: Entity
let stickyInputApplied = false
let stripeGlueTimer = 0
let previousPlayerY = 0
let previousPlayerPosition: { x: number; y: number; z: number } | null = null
let activeJelloJump: ActiveJelloJump | null = null

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

const STRIPE_SURFACE_PROFILES: SurfaceProfile[] = [
  {
    localCenter: Vector3.create(-4.672, 17.223, 5.472),
    halfExtents: Vector3.create(9.08, 4.39, 7.89)
  },
  {
    localCenter: Vector3.create(-3.202, 20.84, -1.922),
    halfExtents: Vector3.create(8.85, 3.86, 6.8)
  },
  {
    localCenter: Vector3.create(7.397, 27.477, 1.787),
    halfExtents: Vector3.create(7.48, 2.17, 9.3)
  }
]

const JELLO_SURFACE_PROFILE: SurfaceProfile = {
  localCenter: Vector3.create(3.036, 4.04, -0.462),
  halfExtents: Vector3.create(9.54, 3.92, 9.68)
}

const JELLPIECE_SURFACE_PROFILE: SurfaceProfile = {
  localCenter: Vector3.create(-0.14, 14.929, 0.127),
  halfExtents: Vector3.create(4.28, 3.5, 3.79)
}

const JELLOPIECE_SURFACE_PROFILE: SurfaceProfile = {
  localCenter: Vector3.create(-2.381, 13.328, -0.419),
  halfExtents: Vector3.create(3.65, 3.56, 2.87)
}

// ── Slot helpers ──────────────────────────────────────────────────────────────
function soloRemaining() {
  return spots.filter((s) => !s.red.collected).length
}

function showSlot(slot: TeamSlot, visible: boolean) {
  VisibilityComponent.createOrReplace(slot.entity, { visible })
  if (GltfContainer.has(slot.entity)) {
    const gltf = GltfContainer.getMutable(slot.entity)
    gltf.visibleMeshesCollisionMask = visible ? ColliderLayer.CL_POINTER : 0
    gltf.invisibleMeshesCollisionMask = 0
  }
}

function resetSlot(slot: TeamSlot, show: boolean) {
  slot.collected = false
  slot.wasInside = false
  slot.respawnTimer = 0
  showSlot(slot, show)
}

function hideAllBerries() {
  for (const s of spots) {
    showSlot(s.red, false)
    showSlot(s.blue, false)
  }
}

function refreshBerrySpots() {
  for (const s of spots) {
    updateBerryRepresentation(s)
    updateBerryTrigger(s)
  }
}

function updateBerryRepresentation(spot: BerrySpot) {
  const shouldShowTeamCollectibles =
    gameMode === 'team' && !!localTeam && (teamPhase === 'countdown' || teamPhase === 'playing')
  const redVisible =
    (gameMode === 'solo' && soloPhase === 'playing' && !spot.red.collected) ||
    (shouldShowTeamCollectibles &&
      localTeam === 'red' &&
      (teamPhase !== 'playing' || !spot.red.collected))
  const blueVisible =
    shouldShowTeamCollectibles &&
    localTeam === 'blue' &&
    (teamPhase !== 'playing' || !spot.blue.collected)

  if (Transform.has(spot.red.entity)) {
    Transform.getMutable(spot.red.entity).scale = scaledBerry(spot.baseScale, GREEN_BEAR_SCALE_MULTIPLIER)
  }
  if (Transform.has(spot.blue.entity)) {
    Transform.getMutable(spot.blue.entity).scale = scaledBerry(spot.baseScale, PURPLE_BEAR_SCALE_MULTIPLIER)
  }

  showSlot(spot.red, redVisible)
  showSlot(spot.blue, blueVisible)
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

function rotateVectorByQuaternion(
  v: { x: number; y: number; z: number },
  q: { x: number; y: number; z: number; w: number }
) {
  const tx = 2 * (q.y * v.z - q.z * v.y)
  const ty = 2 * (q.z * v.x - q.x * v.z)
  const tz = 2 * (q.x * v.y - q.y * v.x)

  return Vector3.create(
    v.x + q.w * tx + (q.y * tz - q.z * ty),
    v.y + q.w * ty + (q.z * tx - q.x * tz),
    v.z + q.w * tz + (q.x * ty - q.y * tx)
  )
}

function getSurfaceBox(surface: CandySurface) {
  const scaledCenter = scaleVector(surface.profile.localCenter, surface.baseScale)
  const rotatedCenter = rotateVectorByQuaternion(scaledCenter, surface.baseRotation)
  const scaledHalf = scaleVector(surface.profile.halfExtents, {
    x: Math.abs(surface.baseScale.x),
    y: Math.abs(surface.baseScale.y),
    z: Math.abs(surface.baseScale.z)
  })
  const rotatedHalfX = rotateVectorByQuaternion(Vector3.create(scaledHalf.x, 0, 0), surface.baseRotation)
  const rotatedHalfZ = rotateVectorByQuaternion(Vector3.create(0, 0, scaledHalf.z), surface.baseRotation)
  const half = Vector3.create(
    Math.abs(rotatedHalfX.x) + Math.abs(rotatedHalfZ.x),
    scaledHalf.y,
    Math.abs(rotatedHalfX.z) + Math.abs(rotatedHalfZ.z)
  )
  const center = Vector3.create(
    surface.basePosition.x + rotatedCenter.x,
    surface.basePosition.y + rotatedCenter.y,
    surface.basePosition.z + rotatedCenter.z
  )

  return {
    center,
    half,
    topY: center.y + half.y
  }
}

function isPlayerOnSurface(
  pos: { x: number; y: number; z: number },
  surface: CandySurface,
  below: number,
  above: number,
  horizontalPadding: number
) {
  const box = getSurfaceBox(surface)
  return (
    Math.abs(pos.x - box.center.x) <= box.half.x + horizontalPadding &&
    Math.abs(pos.z - box.center.z) <= box.half.z + horizontalPadding &&
    pos.y >= box.topY - below &&
    pos.y <= box.topY + above
  )
}

function isPlayerInStripeGlue(pos: { x: number; y: number; z: number }, stripe: CandySurface) {
  const box = getSurfaceBox(stripe)
  return (
    Math.abs(pos.x - box.center.x) <= box.half.x + STRIPE_GLUE_HORIZONTAL_PADDING &&
    Math.abs(pos.z - box.center.z) <= box.half.z + STRIPE_GLUE_HORIZONTAL_PADDING &&
    pos.y >= box.center.y - box.half.y - STRIPE_GLUE_VERTICAL_PADDING_BELOW &&
    pos.y <= box.center.y + box.half.y + STRIPE_GLUE_VERTICAL_PADDING_ABOVE
  )
}

function isStripeIdentifier(src: string, entityName = '') {
  const identifier = `${src} ${entityName}`.toLowerCase()
  return src === STRIPES_SRC || identifier.includes('/stripes/') || identifier.includes('/stripe') || identifier.includes('stripe')
}

function getStripeProfiles(src: string, entityName = '') {
  const identifier = `${src} ${entityName}`.toLowerCase()
  if (identifier.includes('stripe1')) return [STRIPE_SURFACE_PROFILES[0]]
  if (identifier.includes('stripe2')) return [STRIPE_SURFACE_PROFILES[2]]
  if (identifier.includes('stripe3')) return [STRIPE_SURFACE_PROFILES[1]]
  return STRIPE_SURFACE_PROFILES
}

function isJelloIdentifier(src: string, entityName = '') {
  const identifier = `${src} ${entityName}`.toLowerCase()
  return (
    src === JELLO_SRC ||
    src === JELLPIECE_SRC ||
    src === JELLOPIECE_SRC ||
    identifier.includes('/jello/') ||
    identifier.includes('jello.glb') ||
    identifier.includes('/jellpiece/') ||
    identifier.includes('jellpiece.glb') ||
    identifier.includes('/jellopiece/') ||
    identifier.includes('jellopiece.glb')
  )
}

function getJelloProfile(src: string, entityName = '') {
  const identifier = `${src} ${entityName}`.toLowerCase()
  if (identifier.includes('jellopiece')) return JELLOPIECE_SURFACE_PROFILE
  return identifier.includes('jellpiece') ? JELLPIECE_SURFACE_PROFILE : JELLO_SURFACE_PROFILE
}

function setStickyInput(active: boolean) {
  if (active) {
    InputModifier.createOrReplace(engine.PlayerEntity, {
      mode: InputModifier.Mode.Standard({
        disableJog: true,
        disableRun: true,
        disableGliding: true
      })
    })
    stickyInputApplied = true
    return
  }

  if (stickyInputApplied) {
    InputModifier.deleteFrom(engine.PlayerEntity)
    stickyInputApplied = false
  }
}

function applyStripeSlowDrag(pos: { x: number; y: number; z: number }) {
  if (!previousPlayerPosition) return

  const dx = pos.x - previousPlayerPosition.x
  const dz = pos.z - previousPlayerPosition.z
  const movedHorizontal = dx * dx + dz * dz
  if (movedHorizontal < 0.0004) return

  void movePlayerTo({
    newRelativePosition: Vector3.create(pos.x - dx * STRIPE_SLOW_DRAG, pos.y, pos.z - dz * STRIPE_SLOW_DRAG),
    duration: STRIPE_SLOW_STEP_DURATION
  })
}

function updateJelloAnimation(jello: JelloSurface, dt: number) {
  if (!Transform.has(jello.entity)) return

  jello.bounceTimer = Math.max(0, jello.bounceTimer - dt)
  jello.cooldownTimer = Math.max(0, jello.cooldownTimer - dt)

  const transform = Transform.getMutable(jello.entity)
  if (jello.bounceTimer <= 0) {
    transform.position = Vector3.create(jello.basePosition.x, jello.basePosition.y, jello.basePosition.z)
    transform.scale = Vector3.create(jello.baseScale.x, jello.baseScale.y, jello.baseScale.z)
    return
  }

  const progress = 1 - jello.bounceTimer / JELLO_BOUNCE_DURATION
  const fade = 1 - progress
  const wave = Math.sin(progress * Math.PI * 4)
  const stretch = wave * 0.22 * fade
  transform.position = Vector3.create(jello.basePosition.x, jello.basePosition.y + Math.abs(wave) * 0.16 * fade, jello.basePosition.z)
  transform.scale = Vector3.create(
    jello.baseScale.x * (1 - stretch * 0.35),
    jello.baseScale.y * (1 + stretch),
    jello.baseScale.z * (1 - stretch * 0.35)
  )
}

function startJelloJump(pos: { x: number; y: number; z: number }) {
  activeJelloJump = {
    startY: pos.y,
    elapsed: 0
  }
}

function updateActiveJelloJump(dt: number, pos: { x: number; y: number; z: number }) {
  if (!activeJelloJump) return false

  activeJelloJump.elapsed = Math.min(JELLO_SUPER_JUMP_ASCENT_DURATION, activeJelloJump.elapsed + dt)
  const t = activeJelloJump.elapsed / JELLO_SUPER_JUMP_ASCENT_DURATION
  const easedUp = 1 - (1 - t) * (1 - t)
  const jumpY = activeJelloJump.startY + JELLO_SUPER_JUMP_HEIGHT * easedUp

  void movePlayerTo({
    newRelativePosition: Vector3.create(pos.x, jumpY, pos.z),
    duration: JELLO_SUPER_JUMP_STEP_DURATION
  })

  if (activeJelloJump.elapsed >= JELLO_SUPER_JUMP_ASCENT_DURATION) {
    activeJelloJump = null
  }

  return true
}

function updateCandySurfaceEffects(dt: number, pos: { x: number; y: number; z: number }) {
  if (teamPhase === 'finished' || soloPhase === 'finished') {
    activeJelloJump = null
    stripeGlueTimer = 0
    setStickyInput(false)
    previousPlayerY = pos.y
    previousPlayerPosition = Vector3.create(pos.x, pos.y, pos.z)
    return
  }

  stripeGlueTimer = 0
  setStickyInput(false)

  if (activeJelloJump) {
    for (const jello of jellos) updateJelloAnimation(jello, dt)
    updateActiveJelloJump(dt, pos)
    previousPlayerY = pos.y
    previousPlayerPosition = Vector3.create(pos.x, pos.y, pos.z)
    return
  }

  const verticalVelocity = dt > 0 ? (pos.y - previousPlayerY) / dt : 0
  for (const jello of jellos) {
    updateJelloAnimation(jello, dt)
    const box = getSurfaceBox(jello)
    const onJello = isPlayerOnSurface(
      pos,
      jello,
      JELLO_BOUNCE_VERTICAL_BELOW,
      JELLO_BOUNCE_VERTICAL_ABOVE,
      JELLO_BOUNCE_HORIZONTAL_PADDING
    )
    const newTopTouch = onJello && !jello.wasPlayerOnTop

    if (newTopTouch && verticalVelocity <= 0.4 && jello.cooldownTimer <= 0) {
      jello.bounceTimer = JELLO_BOUNCE_DURATION
      jello.cooldownTimer = JELLO_BOUNCE_COOLDOWN
      jello.wasPlayerOnTop = false
      startJelloJump(pos)
    } else {
      jello.wasPlayerOnTop = onJello
    }
  }

  previousPlayerY = pos.y
  previousPlayerPosition = Vector3.create(pos.x, pos.y, pos.z)
}

function getBerryVisualCenter(spot: BerrySpot) {
  const usePurpleBear = gameMode === 'team' && localTeam === 'blue'
  const modelOffset = usePurpleBear ? PURPLE_BEAR_CENTER_OFFSET : GREEN_BEAR_CENTER_OFFSET
  const modelScale = scaledBerry(spot.baseScale, usePurpleBear ? PURPLE_BEAR_SCALE_MULTIPLIER : GREEN_BEAR_SCALE_MULTIPLIER)
  const offset = scaleVector(modelOffset, modelScale)
  return Vector3.create(spot.x + offset.x, spot.y + offset.y, spot.z + offset.z)
}

function getActiveBerryHalfExtents(spot: BerrySpot) {
  const multiplier = gameMode === 'team' && localTeam === 'blue' ? PURPLE_BEAR_SCALE_MULTIPLIER : GREEN_BEAR_SCALE_MULTIPLIER
  const scale = scaledBerry(spot.baseScale, multiplier)
  return scaleVector(BEAR_HALF_EXTENTS, scale)
}

function isPlayerTouchingBerry(pos: { x: number; y: number; z: number }, spot: BerrySpot) {
  const visualCenter = getBerryVisualCenter(spot)
  const half = getActiveBerryHalfExtents(spot)
  const horizontalRadius = Math.max(half.x, half.z) + BERRY_TOUCH_AVATAR_RADIUS
  const dx = pos.x - visualCenter.x
  const dz = pos.z - visualCenter.z
  if (dx * dx + dz * dz > horizontalRadius * horizontalRadius) return false

  const playerBottom = pos.y
  const playerTop = pos.y + PLAYER_TOUCH_HEIGHT
  const berryBottom = visualCenter.y - half.y
  const berryTop = visualCenter.y + half.y

  return playerTop >= berryBottom - BERRY_TOUCH_VERTICAL_PADDING && playerBottom <= berryTop + BERRY_TOUCH_VERTICAL_PADDING
}

function getBerryTriggerTransform(spot: BerrySpot) {
  const visualCenter = getBerryVisualCenter(spot)
  const half = getActiveBerryHalfExtents(spot)
  const radius = Math.max(half.x, half.z) + BERRY_TOUCH_AVATAR_RADIUS + BERRY_TRIGGER_EXTRA_RADIUS

  return {
    position: visualCenter,
    scale: Vector3.create(radius * 2, half.y * 2 + BERRY_TOUCH_VERTICAL_PADDING * 2, radius * 2)
  }
}

function tryCollectBerry(spot: BerrySpot) {
  if (gameMode === 'solo') {
    if (soloPhase !== 'playing' || spot.red.collected || !isPlayerTouchingBerry(getPlayerPosition(), spot)) return
    collectSolo(spot)
    return
  }

  if (gameMode === 'team' && localTeam) {
    if (!canCollectTeamBerry(spot, localTeam, getPlayerPosition())) return
    collectTeam(spot, localTeam, Date.now() + hostClockOffset)
  }
}

function createBerryTrigger(spot: BerrySpot) {
  Transform.create(spot.triggerEntity, getBerryTriggerTransform(spot))
  TriggerArea.setBox(spot.triggerEntity, ColliderLayer.CL_PLAYER)
  triggerAreaEventsSystem.onTriggerEnter(spot.triggerEntity, () => tryCollectBerry(spot))
  triggerAreaEventsSystem.onTriggerStay(spot.triggerEntity, () => tryCollectBerry(spot))
}

function updateBerryTrigger(spot: BerrySpot) {
  Transform.createOrReplace(spot.triggerEntity, getBerryTriggerTransform(spot))
}

function canCollectTeamBerry(spot: BerrySpot, team: Team, pos: { x: number; y: number; z: number }) {
  if (gameMode !== 'team' || teamPhase !== 'playing') return false

  const slot = team === 'red' ? spot.red : spot.blue
  if (slot.collected) return false

  const gltf = GltfContainer.getOrNull(slot.entity)
  if (!gltf) return false
  if (team === 'red' && gltf.src !== GREEN_BEAR_SRC) return false
  if (team === 'blue' && gltf.src !== PURPLE_BEAR_SRC) return false

  const visible = VisibilityComponent.getOrNull(slot.entity)?.visible
  if (!visible) return false

  return isPlayerTouchingBerry(pos, spot)
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

function isStrawberrySource(src: string) {
  return src === STRAWBERRY_SPOT_SRC || src.endsWith('/STRAWBERRY.glb')
}

function isBerryEntity(entity: Entity) {
  const src = GltfContainer.getOrNull(entity)?.src ?? ''
  if (isStrawberrySource(src) || src === GREEN_BEAR_SRC || src === PURPLE_BEAR_SRC) {
    return true
  }
  for (const s of spots) {
    if (s.red.entity === entity) return true
  }
  for (const name of STRAWBERRY_NAMES) {
    if (engine.getEntityOrNullByName(name) === entity) return true
  }
  return false
}

function isRingIdentifier(src: string, entityName = '') {
  const identifier = `${src} ${entityName}`.toLowerCase()
  return identifier.includes(RING_SRC_PART) || identifier.includes('models/ring/') || /^ring.*\.glb/.test(entityName.toLowerCase())
}

function updateRings(dt: number) {
  for (const ring of rings) {
    if (!Transform.has(ring.entity)) continue

    ring.angle = (ring.angle + RING_ROTATION_SPEED_DEGREES * dt) % 360
    const spin = Quaternion.fromEulerDegrees(0, ring.angle, 0)
    const transform = Transform.getMutable(ring.entity)
    transform.position = Vector3.create(ring.basePosition.x, ring.basePosition.y, ring.basePosition.z)
    transform.rotation = Quaternion.multiply(ring.baseRotation, spin)
  }
}

function enableSceneModelColliders() {
  for (const [entity] of engine.getEntitiesWith(GltfContainer)) {
    if (collisionReadyModels.has(entity) || isBerryEntity(entity)) continue
    setModelCollision(entity, true)
    collisionReadyModels.add(entity)
  }
}

function getGumdropProfile(src: string, entityName = ''): GumdropProfile | null {
  const srcIdentifier = src.toLowerCase()
  for (const entry of GUMDROP_PROFILES) {
    if (srcIdentifier.includes(entry.srcPart)) return entry.profile
  }

  const nameIdentifier = entityName.toLowerCase()
  for (const entry of GUMDROP_PROFILES) {
    if (nameIdentifier.includes(entry.srcPart)) return entry.profile
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
  const radius = gumdrop.profile.radius * Math.max(gumdrop.scale.x, gumdrop.scale.z) + GUMDROP_TOUCH_RADIUS_PADDING
  const dx = pos.x - center.x
  const dz = pos.z - center.z
  const topY = getGumdropTopY(gumdrop)

  return (
    dx * dx + dz * dz <= radius * radius &&
    pos.y >= topY - GUMDROP_TOUCH_Y_BELOW &&
    pos.y <= topY + GUMDROP_TOUCH_Y_ABOVE
  )
}

function getGumdropTriggerTransform(gumdrop: GumdropSpot) {
  const center = getGumdropCenter(gumdrop)
  const radius = gumdrop.profile.radius * Math.max(gumdrop.scale.x, gumdrop.scale.z) + GUMDROP_TOUCH_RADIUS_PADDING
  const topY = getGumdropTopY(gumdrop)
  return {
    position: Vector3.create(center.x, topY + (GUMDROP_TOUCH_Y_ABOVE - GUMDROP_TOUCH_Y_BELOW) / 2, center.z),
    scale: Vector3.create(radius * 2, GUMDROP_TRIGGER_HEIGHT, radius * 2)
  }
}

function triggerGumdrop(gumdrop: GumdropSpot) {
  gumdrop.state = 'armed'
  gumdrop.delayTimer = GUMDROP_FALL_DELAY
  gumdrop.fallTimer = 0
}

function startGumdropFall(gumdrop: GumdropSpot) {
  Transform.getMutable(gumdrop.entity).position = Vector3.create(
    gumdrop.startPosition.x,
    gumdrop.startPosition.y,
    gumdrop.startPosition.z
  )
  gumdrop.state = 'falling'
  gumdrop.fallTimer = 0
  gumdrop.respawnTimer = GUMDROP_RESPAWN_DELAY
  setModelCollision(gumdrop.entity, false)
}

function createGumdropTrigger(gumdrop: GumdropSpot) {
  const triggerTransform = getGumdropTriggerTransform(gumdrop)
  Transform.create(gumdrop.triggerEntity, triggerTransform)
  TriggerArea.setBox(gumdrop.triggerEntity, ColliderLayer.CL_PLAYER)
  triggerAreaEventsSystem.onTriggerEnter(gumdrop.triggerEntity, () => {
    if (gumdrop.state === 'ready' && isPlayerTouchingGumdrop(getPlayerPosition(), gumdrop)) triggerGumdrop(gumdrop)
  })
  triggerAreaEventsSystem.onTriggerStay(gumdrop.triggerEntity, () => {
    if (gumdrop.state === 'ready' && isPlayerTouchingGumdrop(getPlayerPosition(), gumdrop)) triggerGumdrop(gumdrop)
  })
}

function resetGumdrop(gumdrop: GumdropSpot) {
  const transform = Transform.getMutable(gumdrop.entity)
  transform.position = Vector3.create(gumdrop.startPosition.x, gumdrop.startPosition.y, gumdrop.startPosition.z)
  VisibilityComponent.createOrReplace(gumdrop.entity, { visible: true })
  setModelCollision(gumdrop.entity, true)
  gumdrop.state = 'ready'
  gumdrop.delayTimer = 0
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

    if (gumdrop.state === 'armed') {
      gumdrop.delayTimer = Math.max(0, gumdrop.delayTimer - dt)
      const elapsed = GUMDROP_FALL_DELAY - gumdrop.delayTimer
      const strength = Math.min(1, elapsed / GUMDROP_FALL_DELAY) * GUMDROP_SHAKE_AMPLITUDE
      const shakeX = Math.sin(elapsed * GUMDROP_SHAKE_SPEED) * strength
      const shakeZ = Math.cos(elapsed * GUMDROP_SHAKE_SPEED * 1.23) * strength
      Transform.getMutable(gumdrop.entity).position = Vector3.create(
        gumdrop.startPosition.x + shakeX,
        gumdrop.startPosition.y,
        gumdrop.startPosition.z + shakeZ
      )
      if (gumdrop.delayTimer <= 0) startGumdropFall(gumdrop)
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
  if (syncedGameplayReady || !myProfile.networkId || spots.length < BERRY_SPOT_TARGET_COUNT) return

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
  localTeam = team === 1 ? 'red' : 'blue'
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
  soloCountdownSoundPlayed = false
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
  playSound(VICTORY_SOUND, 0.95)
  updateSoloState('finished', 0, leaderboard)
}

function collectSolo(s: BerrySpot) {
  if (s.red.collected || soloPhase !== 'playing') return
  s.red.collected = true
  showSlot(s.red, false)
  playSound(COLLECT_SOUND, 1)
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
  playResultSound(winner, localTeam)
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
  playSound(COLLECT_SOUND, 1)
  showCollectPopup(team)
  updateTeamState('playing', teamTimer, teamScores, localTeam)
}

// ── Main ──────────────────────────────────────────────────────────────────────
let soundEntity: Entity
let musicEntity: Entity
const effectSoundEntities: Entity[] = []
let nextEffectSoundEntity = 0
let soloCountdownSoundPlayed = false
let teamCountdownSoundVersion = -1

function playSound(audioClipUrl: string, volume = 1) {
  if (effectSoundEntities.length === 0) return
  ensureMusicPlaying()

  const entity = effectSoundEntities[nextEffectSoundEntity]
  nextEffectSoundEntity = (nextEffectSoundEntity + 1) % effectSoundEntities.length
  const audio = AudioSource.getMutableOrNull(entity)
  if (audio) {
    audio.volume = volume
    audio.loop = false
  }
  AudioSource.playSound(entity, audioClipUrl, true)
}

function ensureMusicPlaying() {
  if (!musicEntity) return
  AudioSource.createOrReplace(musicEntity, {
    audioClipUrl: MUSIC_SOUND,
    playing: true,
    loop: true,
    volume: 0.28,
    currentTime: 0
  })
}

function playResultSound(winner: Team | 'draw', team: Team | null) {
  if (winner === 'draw') {
    playSound(DRAW_SOUND, 0.95)
    return
  }

  playSound(team && winner === team ? VICTORY_SOUND : LOST_SOUND, 0.95)
}

export function main() {
  setupUi()
  setModeSelectCallback(selectMode)
  setChangeModeCallback(goToLobby)
  setCloseLobbyCallback(closeLobby)
  setCloseFinishCallback(closeFinish)
  setJoinTeamCallback(joinTeam)
  setForceStartCallback(forceStart)

  soundEntity = engine.addEntity()
  musicEntity = engine.addEntity()
  AssetLoad.create(engine.RootEntity, { assets: SOUND_ASSETS })
  Transform.create(musicEntity, { position: Vector3.create(0, 1, 0), parent: engine.PlayerEntity })
  for (let i = 0; i < 6; i++) {
    const entity = i === 0 ? soundEntity : engine.addEntity()
    Transform.create(entity, { position: Vector3.create(0, 1, 0), parent: engine.PlayerEntity })
    AudioSource.create(entity, { audioClipUrl: COLLECT_SOUND, playing: false, loop: false, volume: 1, currentTime: 0 })
    effectSoundEntities.push(entity)
  }
  ensureMusicPlaying()

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
  let loggedBerryCount = 0
  let loggedGumdropCount = 0
  let loggedRingCount = 0
  let loggedStripeCount = 0
  let loggedJelloCount = 0

  function ensureSpotsInitialized() {
    if (spotsInitialized) return

    for (const [redEntity, gltf, transform] of engine.getEntitiesWith(GltfContainer, Transform)) {
      if (!isStrawberrySource(gltf.src)) continue

      if (berrySpotMarkers.has(redEntity)) continue
      berrySpotMarkers.add(redEntity)

      const mutableGltf = GltfContainer.getMutable(redEntity)
      mutableGltf.visibleMeshesCollisionMask = 0
      mutableGltf.invisibleMeshesCollisionMask = 0
      VisibilityComponent.createOrReplace(redEntity, { visible: false })

      if (spots.length >= BERRY_SPOT_TARGET_COUNT) continue

      const bx = transform.position.x
      const by = transform.position.y
      const bz = transform.position.z
      const bScale = Vector3.create(transform.scale.x, transform.scale.y, transform.scale.z)
      const bRotation = Quaternion.create(
        transform.rotation.x,
        transform.rotation.y,
        transform.rotation.z,
        transform.rotation.w
      )

      const greenEntity = engine.addEntity()
      Transform.create(greenEntity, {
        position: Vector3.create(bx, by, bz),
        rotation: bRotation,
        scale: scaledBerry(bScale, GREEN_BEAR_SCALE_MULTIPLIER)
      })
      GltfContainer.create(greenEntity, {
        src: GREEN_BEAR_SRC,
        visibleMeshesCollisionMask: 0,
        invisibleMeshesCollisionMask: 0
      })
      VisibilityComponent.createOrReplace(greenEntity, { visible: false })

      const purpleEntity = engine.addEntity()
      Transform.create(purpleEntity, {
        position: Vector3.create(bx, by, bz),
        rotation: bRotation,
        scale: scaledBerry(bScale, PURPLE_BEAR_SCALE_MULTIPLIER)
      })
      GltfContainer.create(purpleEntity, {
        src: PURPLE_BEAR_SRC,
        visibleMeshesCollisionMask: 0,
        invisibleMeshesCollisionMask: 0
      })
      VisibilityComponent.createOrReplace(purpleEntity, { visible: false })

      spots.push({
        x: bx,
        y: by,
        z: bz,
        baseScale: bScale,
        triggerEntity: engine.addEntity(),
        red: { entity: greenEntity, collected: false, wasInside: false, respawnTimer: 0, stateEntity: null },
        blue: { entity: purpleEntity, collected: false, wasInside: false, respawnTimer: 0, stateEntity: null }
      })
      createBerryTrigger(spots[spots.length - 1])
    }

    if (spots.length > loggedBerryCount) {
      loggedBerryCount = spots.length
      console.log('[Candy Rush] Initialized', spots.length, 'berry spots')
    }

    if (spots.length >= BERRY_SPOT_TARGET_COUNT) {
      spotsInitialized = true
      console.log('[Candy Rush] Successfully initialized all', spots.length, 'berry spots!')
    }
  }

  function ensureRingsInitialized() {
    for (const [entity, gltf, transform] of engine.getEntitiesWith(GltfContainer, Transform)) {
      const entityName = Name.getOrNull(entity)?.value ?? ''
      if (!isRingIdentifier(gltf.src, entityName)) continue
      if (rings.some((ring) => ring.entity === entity)) continue

      rings.push({
        entity,
        basePosition: Vector3.create(transform.position.x, transform.position.y, transform.position.z),
        baseRotation: Quaternion.create(transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w),
        angle: 0
      })
    }

    if (rings.length > loggedRingCount) {
      loggedRingCount = rings.length
      console.log('[Candy Rush] Initialized', rings.length, 'rotating rings')
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
        triggerEntity: engine.addEntity(),
        state: 'ready',
        delayTimer: 0,
        fallTimer: 0,
        respawnTimer: 0
      })
      createGumdropTrigger(gumdrops[gumdrops.length - 1])

      VisibilityComponent.createOrReplace(entity, { visible: true })
      setModelCollision(entity, true)
      collisionReadyModels.add(entity)
    }

    if (gumdrops.length > loggedGumdropCount) {
      loggedGumdropCount = gumdrops.length
      console.log('[Candy Rush] Initialized', gumdrops.length, 'gumdrops!')
    }
  }

  function ensureCandySurfacesInitialized() {
    for (const [entity, gltf, transform] of engine.getEntitiesWith(GltfContainer, Transform)) {
      const entityName = Name.getOrNull(entity)?.value ?? ''

      if (isJelloIdentifier(gltf.src, entityName) && !jellos.some((jello) => jello.entity === entity)) {
        jellos.push({
          entity,
          basePosition: Vector3.create(transform.position.x, transform.position.y, transform.position.z),
          baseRotation: Quaternion.create(transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w),
          baseScale: Vector3.create(transform.scale.x, transform.scale.y, transform.scale.z),
          profile: getJelloProfile(gltf.src, entityName),
          bounceTimer: 0,
          cooldownTimer: 0,
          wasPlayerOnTop: false
        })
      }
    }

    if (stickyStripes.length > loggedStripeCount) {
      loggedStripeCount = stickyStripes.length
      console.log('[Candy Rush] Initialized', stickyStripes.length, 'sticky stripe surfaces')
    }

    if (jellos.length > loggedJelloCount) {
      loggedJelloCount = jellos.length
      console.log('[Candy Rush] Initialized', jellos.length, 'jello bounce pads')
    }
  }

  // ── Main system ───────────────────────────────────────────────────────────
  engine.addSystem((dt: number) => {
    ensureSpotsInitialized()
    ensureRingsInitialized()
    ensureGumdropsInitialized()
    ensureCandySurfacesInitialized()
    enableSceneModelColliders()
    updateRings(dt)
    if (spotsInitialized) initializeSyncedGameplay()

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
    updateCandySurfaceEffects(dt, pos)

    if (gameMode !== 'team') refreshBerrySpots()

    tickUi(dt)

    // ── Lobby (idle) ─────────────────────────────────────────────────────────
    if (gameMode === 'lobby' || gameMode === 'idle') return

    // ── Solo countdown ───────────────────────────────────────────────────────
    if (gameMode === 'solo') {
      if (soloPhase === 'countdown') {
        soloCountdownTimer = Math.max(0, soloCountdownTimer - dt)
        updateSoloState('countdown', soloCountdownTimer, leaderboard)
        if (!soloCountdownSoundPlayed && soloCountdownTimer <= COUNTDOWN_SOUND_TRIGGER_REMAINING) {
          playSound(COUNTDOWN_SOUND, 0.9)
          soloCountdownSoundPlayed = true
        }
        if (soloCountdownTimer <= 0) {
          if (spotsInitialized) startSolo()
          else soloCountdownTimer = 0.2
        }
      }

      if (soloPhase === 'playing') {
        soloTimer += dt
        setUiTimer(soloTimer)
        for (const s of spots) {
          if (s.red.collected) continue
          const touchingBerry = isPlayerTouchingBerry(pos, s)
          if (touchingBerry) {
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
          if (pregameTimer <= COUNTDOWN_SOUND_TRIGGER_REMAINING && teamCountdownSoundVersion !== match.version) {
            playSound(COUNTDOWN_SOUND, 0.9)
            teamCountdownSoundVersion = match.version
          }
          teamPhase = 'countdown'
          refreshBerrySpots()
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

        if (localTeam) {
          teamPhase = 'playing'
          syncBerryVisibility(hostNow)
          refreshBerrySpots()

          for (const s of spots) {
            const slot = localTeam === 'red' ? s.red : s.blue
            const touchingBerry = canCollectTeamBerry(s, localTeam, pos)
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
