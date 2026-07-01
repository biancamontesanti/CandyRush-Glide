import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'

export type LeaderboardEntry = { time: number; name?: string; userId?: string }
type Team = 'red' | 'blue'
type GameMode = 'idle' | 'lobby' | 'solo' | 'team'
type TeamPhase = 'idle' | 'waiting' | 'countdown' | 'playing' | 'finished'
type TeamResult = 'win' | 'lose' | 'draw' | null
type PregameStage = 'team' | 'ready' | 'countdown'

// ── Solo state ────────────────────────────────────────────────────────────────
let _soloPhase: 'idle' | 'countdown' | 'playing' | 'finished' = 'idle'
let _soloTimer = 0
let _soloRemaining = 0
let _soloTotal = 0
let _lb: LeaderboardEntry[] = []

// ── Team state ────────────────────────────────────────────────────────────────
let _teamPhase: TeamPhase = 'idle'
let _teamValue = 300
let _teamScores: Record<Team, number> = { red: 0, blue: 0 }
let _localTeam: Team | null = null
let _winner: Team | 'draw' | null = null
let _teamResult: TeamResult = null

// ── Shared ────────────────────────────────────────────────────────────────────
let _gameMode: GameMode = 'lobby'
let _lobbyClosed = false
let _modeMenuCompact = false
let _modeSelectCallback: ((mode: 'solo' | 'team') => void) | null = null
let _changeModeCallback: (() => void) | null = null
let _closeLobbyCallback: (() => void) | null = null
let _closeFinishCallback: (() => void) | null = null
let _joinTeamCallback: ((team: 1 | 2) => void) | null = null
let _forceStartCallback: (() => void) | null = null

// ── Team lobby state ─────────────────────────────────────────────────────────
export type LobbyPlayerInfo = { userId: string; displayName: string; chosenTeam: number }
let _lobbyPlayers: LobbyPlayerInfo[] = []
let _myLobbyUserId = ''
let _lobbyTimeLeft = -1 // seconds until auto-start, -1 = no countdown
let _lobbyIsHost = false
let _lobbyCanStart = false
let _lobbyWarnedUnbalanced = false

let _popupVisible = false
let _popupTimer = 0
let _popupTeam: Team | null = null
let _teamPregameClock = 0
const POPUP_DURATION = 1.2
const TEAM_ASSIGN_CARD_SECONDS = 3
const TEAM_READY_CARD_SECONDS = 3
const TEAM_COUNTDOWN_SECONDS = 4
const TEAM_PREGAME_SECONDS = TEAM_ASSIGN_CARD_SECONDS + TEAM_READY_CARD_SECONDS + TEAM_COUNTDOWN_SECONDS
const HUD_TOP = 82

// ── Exports ───────────────────────────────────────────────────────────────────
export function setupUi() {
  ReactEcsRenderer.setUiRenderer(uiMenu, { virtualWidth: 1920, virtualHeight: 1080 })
}

export function setModeSelectCallback(cb: (mode: 'solo' | 'team') => void) {
  _modeSelectCallback = cb
}
export function setChangeModeCallback(cb: () => void) {
  _changeModeCallback = cb
}
export function setCloseLobbyCallback(cb: () => void) {
  _closeLobbyCallback = cb
}
export function setCloseFinishCallback(cb: () => void) {
  _closeFinishCallback = cb
}
export function setJoinTeamCallback(cb: (team: 1 | 2) => void) {
  _joinTeamCallback = cb
}
export function setForceStartCallback(cb: () => void) {
  _forceStartCallback = cb
}
export function updateLobbyTeams(
  players: LobbyPlayerInfo[],
  myUserId: string,
  timeLeft: number,
  isHost: boolean,
  canStart: boolean,
  warnedUnbalanced?: boolean
) {
  _lobbyPlayers = players
  _myLobbyUserId = myUserId
  _lobbyTimeLeft = timeLeft
  _lobbyIsHost = isHost
  _lobbyCanStart = canStart
  _lobbyWarnedUnbalanced = warnedUnbalanced ?? false
}

export function setUiTimer(t: number) {
  if (_gameMode === 'solo') {
    _soloTimer = Math.max(0, t)
  } else {
    _teamValue = Math.max(0, t)
  }
}

export function tickUi(dt: number) {
  if (_popupVisible) {
    _popupTimer -= dt
    if (_popupTimer <= 0) _popupVisible = false
  }

  if (_gameMode === 'team' && _teamPhase === 'countdown') {
    _teamPregameClock = Math.min(TEAM_PREGAME_SECONDS, _teamPregameClock + dt)
  }
}

export function showCollectPopup(team: Team | null) {
  _popupVisible = true
  _popupTimer = POPUP_DURATION
  _popupTeam = team
}

export function setLobbyClosed(closed: boolean) {
  if (closed) {
    _gameMode = 'lobby'
    _lobbyClosed = false
    _modeMenuCompact = true
  } else {
    _lobbyClosed = false
    _modeMenuCompact = false
  }
}

export function updateLobbyState() {
  _gameMode = 'lobby'
  _lobbyClosed = false
  _modeMenuCompact = false
}

export function updateSoloState(
  phase: 'idle' | 'countdown' | 'playing' | 'finished',
  remaining: number,
  leaderboard: LeaderboardEntry[]
) {
  const previousPhase = _soloPhase
  _gameMode = 'solo'
  _soloPhase = phase
  _soloRemaining = remaining
  if (phase === 'idle' || (phase === 'playing' && previousPhase !== 'playing')) {
    _soloTotal = remaining
  }
  _lb = leaderboard.slice()
}

export function updateTeamState(
  phase: TeamPhase,
  value: number,
  scores: Record<Team, number>,
  localTeam: Team | null,
  winner?: Team | 'draw'
) {
  const wasCountdown = _teamPhase === 'countdown'

  _gameMode = 'team'
  _teamPhase = phase
  _teamValue = Math.max(0, value)
  _teamScores = { ...scores }
  _localTeam = localTeam
  _winner = winner ?? null

  if (phase === 'countdown' && !wasCountdown) {
    _teamPregameClock = 0
  } else if (phase !== 'countdown') {
    _teamPregameClock = 0
  }

  if (phase !== 'finished' || !localTeam || !winner) {
    _teamResult = null
  } else if (winner === 'draw') {
    _teamResult = 'draw'
  } else {
    _teamResult = winner === localTeam ? 'win' : 'lose'
  }
}

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtTime(sec: number): string {
  const m = Math.floor(Math.abs(sec) / 60)
  const s = Math.floor(Math.abs(sec) % 60)
  const ds = Math.floor((Math.abs(sec) % 1) * 10)
  return `${m}:${s.toString().padStart(2, '0')}.${ds}`
}

function fmtCountdown(sec: number): string {
  const s = Math.ceil(Math.max(0, sec))
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`
}

function shortName(name: string | undefined, fallback: string): string {
  const trimmed = (name ?? '').trim()
  const base = trimmed.length > 0 ? trimmed : fallback
  return base.length > 12 ? base.substring(0, 12) : base
}

function pregameLabel(t: number): string {
  if (t > 4) return ''
  if (t > 3) return '3'
  if (t > 2) return '2'
  if (t > 1) return '1'
  return 'GO!'
}

function getCountdownImage(t: number): string {
  if (t > 4) return ''
  if (t > 3) return 'assets/ui/countdown/3.png'
  if (t > 2) return 'assets/ui/countdown/2.png'
  if (t > 1) return 'assets/ui/countdown/1.png'
  return 'assets/ui/countdown/go.png'
}

function getTeamPregameStage(t: number): PregameStage {
  if (t > TEAM_READY_CARD_SECONDS + TEAM_COUNTDOWN_SECONDS) return 'team'
  if (t > TEAM_COUNTDOWN_SECONDS) return 'ready'
  return 'countdown'
}

function getTeamPregameStageFromClock(t: number): PregameStage {
  if (t < TEAM_ASSIGN_CARD_SECONDS) return 'team'
  if (t < TEAM_ASSIGN_CARD_SECONDS + TEAM_READY_CARD_SECONDS) return 'ready'
  return 'countdown'
}

function getTeamIntroImage(team: Team | null): string {
  return team === 'blue' ? 'assets/ui/choosemodeui/purpleteam.png' : 'assets/ui/choosemodeui/greenteam.png'
}

function resultTitleImage(result: TeamResult): string {
  if (result === 'win') return 'assets/ui/results/won.png'
  if (result === 'lose') return 'assets/ui/results/lost.png'
  if (result === 'draw') return 'assets/ui/results/draw.png'
  return ''
}

function resultMessageImage(result: TeamResult): string {
  if (result === 'win') return 'assets/ui/results/won-message.png'
  if (result === 'lose') return 'assets/ui/results/lostmessage.png'
  return 'assets/ui/results/draw-message.png'
}

function closeUiState() {
  _gameMode = 'lobby'
  _lobbyClosed = false
  _modeMenuCompact = true
  _soloPhase = 'idle'
  _teamPhase = 'idle'
  _teamResult = null
  _popupVisible = false
  _teamPregameClock = 0
}

function handleCloseLobby() {
  _closeLobbyCallback?.()
  closeUiState()
}

function handleJoinTeam(team: 1 | 2) {
  if (_myLobbyUserId) {
    _lobbyPlayers = _lobbyPlayers.map((player) =>
      player.userId === _myLobbyUserId ? { ...player, chosenTeam: team } : player
    )
  }
  _joinTeamCallback?.(team)
}

function handleCloseFinish() {
  _closeFinishCallback?.()
  closeUiState()
}

// ── Palette ───────────────────────────────────────────────────────────────────
const RED = { r: 0.259, g: 0.384, b: 0.153, a: 1 }
const BLUE = { r: 0.6, g: 0.2, b: 0.8, a: 1 }
const GOLD = { r: 1, g: 0.84, b: 0, a: 1 }
const WHT = { r: 1, g: 1, b: 1, a: 1 }
const GRY = { r: 0.6, g: 0.6, b: 0.6, a: 1 }
const YLW = { r: 1, g: 1, b: 0.2, a: 1 }
const INK = { r: 0.02, g: 0.02, b: 0.02, a: 1 }
const BG = { r: 0, g: 0, b: 0, a: 0.82 }

// ── Root ──────────────────────────────────────────────────────────────────────
export const uiMenu = () => {
  const popupAlpha = _popupVisible
    ? Math.min(1, _popupTimer / 0.3) * Math.min(1, _popupTimer / (POPUP_DURATION * 0.8))
    : 0
  const popupColor =
    _popupTeam === 'red'
      ? { ...RED, a: popupAlpha }
      : _popupTeam === 'blue'
        ? { ...BLUE, a: popupAlpha }
        : { ...RED, a: popupAlpha }
  const popupText = _popupTeam === 'red' ? '+1  GREEN' : _popupTeam === 'blue' ? '+1  PURPLE' : '+ 1  Collected!'

  const teamColor = _localTeam === 'red' ? RED : BLUE
  const teamLabel = _localTeam === 'red' ? 'GREEN' : _localTeam === 'blue' ? 'PURPLE' : ''
  const teamPregameStage =
    _gameMode === 'team' && _teamPhase === 'countdown' ? getTeamPregameStageFromClock(_teamPregameClock) : null
  const localTeamSplashImage = getTeamIntroImage(_localTeam)
  const teamCountdownValue =
    teamPregameStage === 'countdown'
      ? Math.max(0, TEAM_COUNTDOWN_SECONDS - (_teamPregameClock - TEAM_ASSIGN_CARD_SECONDS - TEAM_READY_CARD_SECONDS))
      : TEAM_COUNTDOWN_SECONDS
  const teamCountdownImage = teamPregameStage === 'countdown' ? getCountdownImage(teamCountdownValue) : ''
  const localScore = _localTeam === 'blue' ? _teamScores.blue : _teamScores.red
  const opponentScore = _localTeam === 'blue' ? _teamScores.red : _teamScores.blue
  const resultTitle = resultTitleImage(_teamResult)
  const resultMessage = resultMessageImage(_teamResult)
  const resultLeftColor = _localTeam === 'blue' ? BLUE : RED
  const resultRightColor = _localTeam === 'blue' ? RED : BLUE
  const resultTitleWidth = _teamResult === 'draw' ? 164 : 294
  const resultTitleHeight = _teamResult === 'draw' ? 31 : 19
  const modeMenuShellTransform = _modeMenuCompact
    ? {
        positionType: 'absolute' as const,
        position: { top: 88, right: 42 },
        width: 390,
        height: 372,
        flexDirection: 'column' as const,
        justifyContent: 'flex-start' as const,
        alignItems: 'center' as const
      }
    : {
        positionType: 'absolute' as const,
        position: { top: 0, left: 0, right: 0, bottom: 0 },
        flexDirection: 'column' as const,
        justifyContent: 'center' as const,
        alignItems: 'center' as const
      }
  const modeMenuPanelTransform = _modeMenuCompact
    ? {
        width: 390,
        height: 372,
        flexShrink: 0,
        flexDirection: 'column' as const,
        alignItems: 'center' as const,
        padding: { top: 116, bottom: 28, left: 30, right: 30 },
        positionType: 'relative' as const
      }
    : {
        width: 540,
        height: 520,
        flexShrink: 0,
        flexDirection: 'column' as const,
        alignItems: 'center' as const,
        padding: { top: 160, bottom: 40, left: 40, right: 40 },
        positionType: 'relative' as const
      }
  const modeMenuTitleTransform = _modeMenuCompact
    ? {
        positionType: 'absolute' as const,
        position: { top: -80, left: 20 },
        width: 350,
        height: 193,
        pointerFilter: 'none' as const
      }
    : {
        positionType: 'absolute' as const,
        position: { top: -110, left: 30 },
        width: 480,
        height: 264,
        pointerFilter: 'none' as const
      }

  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%' }}>
      {/* ── Team: Lobby ───────────────────────────────────────────────────── */}
      {_gameMode === 'team' &&
        _teamPhase === 'waiting' &&
        (() => {
          const redPlayers = _lobbyPlayers.filter((p) => p.chosenTeam === 1)
          const bluePlayers = _lobbyPlayers.filter((p) => p.chosenTeam === 2)
          const unassigned = _lobbyPlayers.filter((p) => p.chosenTeam === 0)
          const diff = Math.abs(redPlayers.length - bluePlayers.length)
          const myTeam = _lobbyPlayers.find((p) => p.userId === _myLobbyUserId)?.chosenTeam ?? 0

          let warningText = ''
          let warningColor = GRY

          if (_lobbyTimeLeft >= 0) {
            // Countdown active
          } else if (_lobbyPlayers.length === 0) {
            warningText = 'Waiting for players...'
          } else if (unassigned.length > 0) {
            warningText = `${unassigned.length} player${unassigned.length > 1 ? 's' : ''} haven't picked a team yet`
            warningColor = YLW
          } else if (redPlayers.length === 0 || bluePlayers.length === 0) {
            warningText = 'Each team needs at least 1 player!'
            warningColor = INK
          } else if (diff >= 3) {
            warningText = `⚠️ Very uneven! ${redPlayers.length} vs ${bluePlayers.length}  — rebalance for a fair fight`
            warningColor = { r: 1, g: 0.3, b: 0.3, a: 1 }
          } else if (diff === 2) {
            warningText = `Uneven teams: GREEN ${redPlayers.length}  vs  PURPLE ${bluePlayers.length}`
            warningColor = YLW
          } else if (diff === 1) {
            warningText = `Slightly uneven: GREEN ${redPlayers.length}  vs  PURPLE ${bluePlayers.length}`
            warningColor = { r: 1, g: 0.75, b: 0.2, a: 1 }
          }

          return (
            <UiEntity
              uiTransform={{
	                positionType: 'absolute',
	                position: { top: '50%', left: '50%' },
	                width: 600,
	                height: 680,
	                margin: { left: -300, top: -340 },
	                flexDirection: 'column',
	                alignItems: 'center',
	                padding: { top: 110, bottom: 32, left: 28, right: 28 }
	              }}
              uiBackground={{
                textureMode: 'nine-slices',
                texture: { src: 'assets/ui/teambattlelobby/backgroundbox.png' },
                textureSlices: { top: 0.15, bottom: 0.15, left: 0.15, right: 0.15 }
              }}
            >
              {/* Bears at bottom */}
              <UiEntity
                uiTransform={{
                  positionType: 'absolute',
                  position: { bottom: -70, left: -50 },
                  width: 700,
                  height: 167,
                  pointerFilter: 'none'
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/ui/teambattlelobby/bears.png' } }}
              />

              {/* Candy Rush Title */}
              <UiEntity
                uiTransform={{
                  positionType: 'absolute',
                  position: { top: -110, left: 60 },
                  width: 480,
                  height: 264,
                  pointerFilter: 'none'
                }}
                uiBackground={{
                  textureMode: 'stretch',
                  texture: { src: 'assets/ui/teambattlelobby/candyrushtitle.png' }
                }}
              />

              {/* Team Battle Lobby title */}
              <UiEntity
                uiTransform={{ width: 300, height: 48, margin: { top: 25, bottom: 10 } }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/ui/teambattlelobby/teamlobby.png' } }}
              />

              {/* Choose Your Side title */}
              <UiEntity
                uiTransform={{ width: 400, height: 23, margin: { bottom: 10 } }}
                uiBackground={{
                  textureMode: 'stretch',
                  texture: { src: 'assets/ui/teambattlelobby/chooseyourside.png' }
                }}
              />

              {/* Two team columns */}
	              <UiEntity
	                uiTransform={{ flexDirection: 'row', margin: { top: 14 }, width: '100%', justifyContent: 'center' }}
	              >
	                {/* GREEN column */}
	                <UiEntity
	                  uiTransform={{
	                    width: 210,
	                    height: 337,
	                    flexDirection: 'column',
	                    alignItems: 'center',
	                    positionType: 'relative',
	                    padding: { top: 92, bottom: 22, left: 14, right: 14 },
	                    margin: { right: 12 }
	                  }}
	                  onMouseDown={() => handleJoinTeam(1)}
	                >
	                  <UiEntity
	                    uiTransform={{
	                      positionType: 'absolute',
	                      position: { top: 0, left: 0 },
	                      width: 210,
	                      height: 337,
	                      pointerFilter: 'none'
	                    }}
	                    uiBackground={{
	                      textureMode: 'stretch',
	                      texture: { src: 'assets/ui/teambattlelobby/greenside.png' }
	                    }}
	                  />
	                  {redPlayers.length === 0 && (
	                    <Label
                      font="sans-serif"
                      value={'empty'}
                      fontSize={16}
                      color={WHT}
                      uiTransform={{ margin: { bottom: 6 } }}
                    />
                  )}
                  {redPlayers.map((p) => (
                    <Label
                      font="sans-serif"
                      key={p.userId}
                      value={p.displayName}
                      fontSize={18}
                      color={WHT}
                      uiTransform={{ margin: { bottom: 4 } }}
                    />
                  ))}
                  <UiEntity uiTransform={{ flex: 1 }} />
                  <Label font="sans-serif" value={myTeam === 1 ? '> YOU' : 'JOIN'} fontSize={20} color={myTeam === 1 ? YLW : GRY} />
                </UiEntity>

                {/* PURPLE column */}
	                <UiEntity
	                  uiTransform={{
	                    width: 210,
	                    height: 338,
	                    flexDirection: 'column',
	                    alignItems: 'center',
	                    positionType: 'relative',
	                    padding: { top: 92, bottom: 22, left: 14, right: 14 },
	                    margin: { left: 12 }
	                  }}
	                  onMouseDown={() => handleJoinTeam(2)}
	                >
	                  <UiEntity
	                    uiTransform={{
	                      positionType: 'absolute',
	                      position: { top: 0, left: 0 },
	                      width: 210,
	                      height: 338,
	                      pointerFilter: 'none'
	                    }}
	                    uiBackground={{
	                      textureMode: 'stretch',
	                      texture: { src: 'assets/ui/teambattlelobby/purpleside.png' }
	                    }}
	                  />
	                  {bluePlayers.length === 0 && (
                    <Label
                      font="sans-serif"
                      value={'empty'}
                      fontSize={16}
                      color={WHT}
                      uiTransform={{ margin: { bottom: 6 } }}
                    />
                  )}
                  {bluePlayers.map((p) => (
                    <Label
                      font="sans-serif"
                      key={p.userId}
                      value={p.displayName}
                      fontSize={18}
                      color={WHT}
                      uiTransform={{ margin: { bottom: 4 } }}
                    />
                  ))}
                  <UiEntity uiTransform={{ flex: 1 }} />
                  <Label font="sans-serif" value={myTeam === 2 ? '> YOU' : 'JOIN'} fontSize={20} color={myTeam === 2 ? YLW : GRY} />
                </UiEntity>
              </UiEntity>

              {/* Status / warning (no countdown active) */}
              {_lobbyTimeLeft < 0 && warningText !== '' && (
                <Label
                  font="sans-serif"
                  value={warningText}
                  fontSize={17}
                  color={warningColor}
                  uiTransform={{ margin: { top: 14 } }}
                />
              )}

              {/* Lobby countdown bar */}
              {_lobbyTimeLeft >= 0 && (
                <UiEntity
                  uiTransform={{ flexDirection: 'column', alignItems: 'center', margin: { top: 14 }, width: '100%' }}
                >
                  <Label
                    font="sans-serif"
                    value={`Match starts in ${Math.ceil(_lobbyTimeLeft)}s…`}
                    fontSize={16}
                    color={{ r: 0, g: 0, b: 0, a: 1 }}
                  />
                  {diff > 0 && (
                    <Label
                      font="sans-serif"
                      value={`Teams uneven — switch teams to balance!`}
                      fontSize={14}
                      color={{ r: 1, g: 0, b: 0, a: 1 }}
                      uiTransform={{ margin: { top: 4 } }}
                    />
                  )}
                </UiEntity>
              )}

              {/* Host controls */}
              <UiEntity uiTransform={{ flexDirection: 'row', margin: { top: 10 }, alignItems: 'center' }}>
                {_lobbyIsHost && _lobbyCanStart && (
                  <UiEntity
                    uiTransform={{ width: 260, height: 50, margin: { right: 10 } }}
                    uiBackground={{
                      textureMode: 'stretch',
                      texture: { src: 'assets/ui/teambattlelobby/startmatchnow.png' }
                    }}
                    onMouseDown={() => _forceStartCallback?.()}
                  />
                )}
              </UiEntity>

              {/* X close button */}
              <UiEntity
                uiTransform={{ positionType: 'absolute', position: { top: 30, right: 30 }, width: 46, height: 48 }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/ui/choosemodeui/closebutton.png' } }}
                onMouseDown={() => handleCloseLobby()}
              />
            </UiEntity>
          )
        })()}
      {/* ── Lobby: Mode selector ────────────────────────────────────────── */}
      {_gameMode === 'lobby' && !_lobbyClosed && (
        <UiEntity uiTransform={modeMenuShellTransform}>
          <UiEntity
            uiTransform={modeMenuPanelTransform}
            uiBackground={{
              textureMode: 'nine-slices',
              texture: { src: 'assets/ui/choosemodeui/backgroundbox.png' },
              textureSlices: { top: 0.15, bottom: 0.15, left: 0.15, right: 0.15 }
            }}
          >
            <UiEntity
              uiTransform={modeMenuTitleTransform}
              uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/ui/choosemodeui/candyrushtitle.png' } }}
            />
            {!_modeMenuCompact && (
              <UiEntity
                uiTransform={{
                  positionType: 'absolute',
                  position: { bottom: 35, right: 35 },
                  width: 69,
                  height: 72
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/ui/choosemodeui/closebutton.png' } }}
                onMouseDown={() => handleCloseLobby()}
              />
            )}
            <UiEntity
              uiTransform={{
                width: _modeMenuCompact ? 280 : 400,
                height: _modeMenuCompact ? 16 : 23,
                margin: { bottom: _modeMenuCompact ? 18 : 25 }
              }}
              uiBackground={{
                textureMode: 'stretch',
                texture: { src: 'assets/ui/choosemodeui/choose your mode title.png' }
              }}
            />
            <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', width: '100%' }}>
              <UiEntity
                uiTransform={{
                  width: _modeMenuCompact ? 246 : 324,
                  height: _modeMenuCompact ? 55 : 72,
                  margin: { bottom: _modeMenuCompact ? 6 : 8 }
                }}
                uiBackground={{
                  textureMode: 'stretch',
                  texture: { src: 'assets/ui/choosemodeui/teambattlebutton.png' }
                }}
                onMouseDown={() => _modeSelectCallback?.('team')}
              />
              {!_modeMenuCompact && (
                <UiEntity
                  uiTransform={{
                    width: 328,
                    height: 37,
                    margin: { bottom: 15 }
                  }}
                  uiBackground={{
                    textureMode: 'stretch',
                    texture: { src: 'assets/ui/choosemodeui/teamvsteamdescription.png' }
                  }}
                />
              )}
            </UiEntity>
            <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', width: '100%' }}>
              <UiEntity
                uiTransform={{
                  width: _modeMenuCompact ? 246 : 324,
                  height: _modeMenuCompact ? 55 : 72,
                  margin: { bottom: _modeMenuCompact ? 6 : 8 }
                }}
                uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/ui/choosemodeui/solorunbutton.png' } }}
                onMouseDown={() => _modeSelectCallback?.('solo')}
              />
              {!_modeMenuCompact && (
                <UiEntity
                  uiTransform={{
                    width: 295,
                    height: 15,
                    margin: { bottom: 15 }
                  }}
                  uiBackground={{
                    textureMode: 'stretch',
                    texture: { src: 'assets/ui/choosemodeui/solomodedescription.png' }
                  }}
                />
              )}
            </UiEntity>
          </UiEntity>
        </UiEntity>
      )}

      {/* ── Solo HUD (top-right) ────────────────────────────────────────── */}
      {_gameMode === 'solo' && _soloPhase !== 'countdown' && _soloPhase !== 'finished' && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: HUD_TOP, right: 42 },
            width: 430,
            height: 162,
            flexDirection: 'column',
            alignItems: 'center',
            padding: { top: 22, right: 22, bottom: 16, left: 22 }
          }}
          uiBackground={{
            textureMode: 'nine-slices',
            texture: { src: 'assets/ui/choosemodeui/backgroundbox.png' },
            textureSlices: { top: 0.15, bottom: 0.15, left: 0.15, right: 0.15 }
          }}
        >
          {/* Candy Rush Title */}
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { top: -78, left: -28 },
              width: 286,
              height: 157,
              pointerFilter: 'none'
            }}
            uiBackground={{
              textureMode: 'stretch',
              texture: { src: 'assets/ui/choosemodeui/candyrushtitle.png' }
            }}
          />

          {/* Mode label (bottom left overlapping edge) */}
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { bottom: -14, left: 18 },
              width: 176,
              height: 39
            }}
            uiBackground={{
              textureMode: 'stretch',
              texture: { src: 'assets/ui/choosemodeui/solorunbutton.png' }
            }}
            onMouseDown={() => _modeSelectCallback?.('solo')}
          />

          <UiEntity
            uiTransform={{
              width: '100%',
              height: '100%',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'flex-end'
            }}
          >
            {_soloPhase === 'idle' ? (
              <UiEntity uiTransform={{ width: 158, flexDirection: 'column', alignItems: 'center', margin: { top: 8 } }}>
                <Label font="monospace" value={'WALK'} fontSize={17} color={INK} />
                <Label font="monospace" value={'THROUGH'} fontSize={17} color={INK} />
                <Label font="monospace" value={'START!'} fontSize={17} color={INK} />
              </UiEntity>
            ) : (
              <UiEntity uiTransform={{ width: 210, flexDirection: 'column', alignItems: 'center', margin: { top: 8 } }}>
                <Label
                  font="monospace"
                  value={fmtTime(_soloTimer)}
                  fontSize={34}
                  color={INK}
                />
                <Label
                  font="monospace"
                  value={`${Math.ceil(Math.max(0, _soloRemaining))} LEFT`}
                  fontSize={24}
                  color={RED}
                  uiTransform={{ margin: { top: 6 } }}
                />
                {/* <Label
                  font="monospace"
                  value={'TO COLLECT'}
                  fontSize={15}
                  color={INK}
                /> */}
              </UiEntity>
            )}
          </UiEntity>

          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { bottom: 10, right: 12 }, width: 28, height: 29 }}
            uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/ui/results/closebutton.png' } }}
            onMouseDown={() => handleCloseLobby()}
          />
        </UiEntity>
      )}

      {/* ── Solo: Finished leaderboard modal ────────────────────────────── */}
      {_gameMode === 'solo' && _soloPhase === 'finished' && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: '50%', left: '50%' },
            width: 500,
            height: 538,
            margin: { left: -250, top: -269 },
            flexDirection: 'column',
            alignItems: 'center',
            padding: { top: 170, bottom: 42, left: 48, right: 48 }
          }}
          uiBackground={{ textureMode: 'nine-slices', texture: { src: 'assets/ui/results/backgroundbox.png' } }}
        >
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { top: -118, left: 73 },
              width: 354,
              height: 195,
              pointerFilter: 'none'
            }}
            uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/ui/results/candyrushtitle.png' } }}
          />

          <UiEntity
            uiTransform={{ width: 278, height: 23, margin: { bottom: 20 }, pointerFilter: 'none' }}
            uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/ui/results/LEADERBOARD.png' } }}
          />

          <Label
            font="monospace"
            value={`YOUR TIME  ${fmtTime(_soloTimer)}`}
            fontSize={24}
            color={INK}
            uiTransform={{ margin: { bottom: 16 } }}
          />

          <UiEntity uiTransform={{ width: '100%', flexDirection: 'column', alignItems: 'center' }}>
            {_lb.slice(0, 5).map((entry, index) => (
              <UiEntity
                key={`solo-leaderboard-${index}`}
                uiTransform={{
                  width: 360,
                  height: 34,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  margin: { bottom: 7 }
                }}
              >
                <Label
                  font="monospace"
                  value={`${index + 1}. ${shortName(entry.name, 'PLAYER')}`}
                  fontSize={18}
                  color={index === 0 ? GOLD : INK}
                  textAlign="middle-left"
                  textWrap="nowrap"
                />
                <Label
                  font="monospace"
                  value={fmtTime(entry.time)}
                  fontSize={18}
                  color={index === 0 ? GOLD : INK}
                  textAlign="middle-right"
                  textWrap="nowrap"
                />
              </UiEntity>
            ))}
            {_lb.length === 0 && <Label font="monospace" value={'NO TIMES YET'} fontSize={20} color={INK} />}
          </UiEntity>

          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { bottom: 26, right: 31 }, width: 42, height: 44 }}
            uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/ui/results/closebutton.png' } }}
            onMouseDown={() => handleCloseLobby()}
          />
        </UiEntity>
      )}

      {/* ── Solo countdown 3-2-1-GO! ────────────────────────────────────── */}
      {_gameMode === 'solo' && _soloPhase === 'countdown' && _soloRemaining <= 4 && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: '50%', left: '50%' },
            width: 500,
            height: 545,
            margin: { left: -250, top: -272 },
            flexDirection: 'column',
            alignItems: 'center'
          }}
          uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/ui/choosemodeui/getreadytostart.png' } }}
        >
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { bottom: 60 },
              width: _soloRemaining <= 1 ? 315 : 90,
              height: 90
            }}
            uiBackground={{ textureMode: 'stretch', texture: { src: getCountdownImage(_soloRemaining) } }}
          />
        </UiEntity>
      )}

      {/* ── Team: assignment card, ready card, then 3-2-1-GO ─────────────── */}
      {_gameMode === 'team' && _teamPhase === 'countdown' && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: 0, left: 0, right: 0, bottom: 0 },
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            pointerFilter: 'none'
          }}
        >
          {teamPregameStage === 'team' && (
            <UiEntity
              uiTransform={{
                width: 332,
                height: _localTeam === 'blue' ? 407 : 385
              }}
              uiBackground={{ textureMode: 'stretch', texture: { src: localTeamSplashImage } }}
            />
          )}

          {teamPregameStage === 'ready' && (
            <UiEntity
              uiTransform={{
                width: 332,
                height: 362
              }}
              uiBackground={{
                textureMode: 'stretch',
                texture: { src: 'assets/ui/teambattlelobby/getreadytostart.png' }
              }}
            />
          )}

          {teamPregameStage === 'countdown' && teamCountdownImage !== '' && (
            <UiEntity
              uiTransform={{
                width: teamCountdownValue <= 1 ? 520 : 180,
                height: teamCountdownValue <= 1 ? 148 : 180
              }}
              uiBackground={{
                textureMode: 'stretch',
                texture: { src: teamCountdownImage }
              }}
            />
          )}
        </UiEntity>
      )}

      {/* ── Team: Playing HUD (top-right) ───────────────────────────────── */}
      {_gameMode === 'team' && _teamPhase === 'playing' && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: HUD_TOP, right: 42 },
            width: 430,
            height: 162,
            flexDirection: 'column',
            alignItems: 'center',
            padding: { top: 22, right: 22, bottom: 16, left: 22 }
          }}
          uiBackground={{
            textureMode: 'nine-slices',
            texture: { src: 'assets/ui/choosemodeui/backgroundbox.png' },
            textureSlices: { top: 0.15, bottom: 0.15, left: 0.15, right: 0.15 }
          }}
        >
          {/* Candy Rush Title */}
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { top: -78, left: -28 },
              width: 286,
              height: 157,
              pointerFilter: 'none'
            }}
            uiBackground={{
              textureMode: 'stretch',
              texture: { src: 'assets/ui/choosemodeui/candyrushtitle.png' }
            }}
          />

          {/* Mode label (bottom left overlapping edge) */}
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { bottom: -14, left: 18 },
              width: 176,
              height: 39
            }}
            uiBackground={{
              textureMode: 'stretch',
              texture: { src: 'assets/ui/choosemodeui/teambattlebutton.png' }
            }}
            onMouseDown={() => _modeSelectCallback?.('team')}
          />

          <UiEntity
            uiTransform={{
              flexDirection: 'column',
              alignItems: 'center',
              width: '100%',
              margin: { top: 4 }
            }}
          >
            <Label
              font="monospace"
              value={fmtCountdown(_teamValue)}
              fontSize={38}
              color={INK}
              uiTransform={{ margin: { left: 168, bottom: 8 } }}
            />
            <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { top: 2 } }}>
              <Label font="monospace" value={'GREEN'} fontSize={22} color={RED} />
              <Label
                font="monospace"
                value={`  ${_teamScores.red}  `}
                fontSize={24}
                color={RED}
                uiTransform={{ margin: { left: 14 } }}
              />
              <Label font="monospace" value={'|'} fontSize={24} color={{ r: 0.85, g: 0.45, b: 0.3, a: 1 }} />
              <Label
                font="monospace"
                value={`  ${_teamScores.blue}  `}
                fontSize={24}
                color={BLUE}
                uiTransform={{ margin: { right: 14 } }}
              />
              <Label font="monospace" value={'PURPLE'} fontSize={22} color={BLUE} />
            </UiEntity>
            {/* {_localTeam && (
              <Label
                font="sans-serif"
                value={`You: ${teamLabel} team`}
                fontSize={22}
                color={teamColor}
                uiTransform={{ margin: { top: 8, left: 158 } }}
              />
            )} */}
          </UiEntity>

          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { bottom: 10, right: 12 }, width: 28, height: 29 }}
            uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/ui/results/closebutton.png' } }}
            onMouseDown={() => handleCloseLobby()}
          />
        </UiEntity>
      )}

      {/* ── Team: Finished result modal ──────────────────────────────────── */}
      {_gameMode === 'team' && _teamPhase === 'finished' && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: '50%', left: '50%' },
            width: 500,
            height: 538,
            margin: { left: -250, top: -269 },
            flexDirection: 'column',
            alignItems: 'center',
            padding: { top: 178, bottom: 42, left: 42, right: 42 }
          }}
          uiBackground={{ textureMode: 'nine-slices', texture: { src: 'assets/ui/results/backgroundbox.png' } }}
        >
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { top: -118, left: 73 },
              width: 354,
              height: 195,
              pointerFilter: 'none'
            }}
            uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/ui/results/candyrushtitle.png' } }}
          />

          {resultTitle !== '' ? (
            <UiEntity
              uiTransform={{
                width: resultTitleWidth,
                height: resultTitleHeight,
                margin: { bottom: _teamResult === 'draw' ? 18 : 26 },
                pointerFilter: 'none'
              }}
              uiBackground={{ textureMode: 'stretch', texture: { src: resultTitle } }}
            />
          ) : (
            <Label
              font="monospace"
              value={'DRAW!'}
              fontSize={40}
              color={INK}
              uiTransform={{ margin: { bottom: 21 } }}
            />
          )}

          <UiEntity uiTransform={{ flexDirection: 'row', alignItems: 'center', margin: { bottom: 23 } }}>
            <Label font="monospace" value={`${localScore}`} fontSize={64} color={resultLeftColor} />
            <Label
              font="monospace"
              value={'  x  '}
              fontSize={34}
              color={INK}
              uiTransform={{ margin: { top: 6 } }}
            />
            <Label font="monospace" value={`${opponentScore}`} fontSize={64} color={resultRightColor} />
          </UiEntity>

          <UiEntity
            uiTransform={{
              width: _teamResult === 'lose' ? 229 : _teamResult === 'win' ? 200 : 168,
              height: 36,
              margin: { bottom: 29 },
              pointerFilter: 'none'
            }}
            uiBackground={{ textureMode: 'stretch', texture: { src: resultMessage } }}
          />

          <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', width: '100%' }}>
            <UiEntity
              uiTransform={{ width: 300, height: 67, margin: { bottom: 13 } }}
              uiBackground={{
                textureMode: 'stretch',
                texture: { src: 'assets/ui/choosemodeui/teambattlebutton.png' }
              }}
              onMouseDown={() => _modeSelectCallback?.('team')}
            />
            <UiEntity
              uiTransform={{ width: 255, height: 57 }}
              uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/ui/choosemodeui/solorunbutton.png' } }}
              onMouseDown={() => _modeSelectCallback?.('solo')}
            />
          </UiEntity>

          <UiEntity
            uiTransform={{ positionType: 'absolute', position: { bottom: 26, right: 31 }, width: 42, height: 44 }}
            uiBackground={{ textureMode: 'stretch', texture: { src: 'assets/ui/results/closebutton.png' } }}
            onMouseDown={() => handleCloseFinish()}
          />
        </UiEntity>
      )}

      {/* ── Collect popup ───────────────────────────────────────────────── */}
      {_popupVisible && (
        <UiEntity
          uiTransform={{
            positionType: 'absolute',
            position: { top: '40%', left: '50%' },
            width: 260,
            height: 60,
            margin: { left: -130 },
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <Label font="monospace" value={popupText} fontSize={28} color={popupColor} />
        </UiEntity>
      )}
    </UiEntity>
  )
}
