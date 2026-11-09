# WORLDBEAST audio

Everything you hear is synthesised in the browser with Web Audio: oscillators, noise, filters, a waveshaper, a convolution reverb with a generated impulse response, and two compressors with a soft ceiling. There are no audio files and no samples from anywhere else.

## Files

| File | What it does |
| --- | --- |
| `AudioEngine.ts` | The public class: the mix graph, the lookahead scheduler, the score player, volley voicing and sfx |
| `score.ts` | Pure data. Builds a titan's Canticle from its seed: mode, progressions, motif and its development, percussion and bass patterns, and the audio events for every volley |
| `synth.ts` | The instruments (bell, psaltery, taiko, frame drum, clack, jingles, shawm, organ, bowed glass, pedal bass, bowed metal, air, gong, sub), voice caps, the cathedral IR and the ceiling curve |
| `bank.ts` | Renders the struck instruments once on an OfflineAudioContext with the same synth voices, then replays them as buffers (far cheaper on phones) |
| `lane.ts` | Automation lanes for long-lived params: ramps that end, so the browser keeps them on its fast path |
| `demo.html`, `demo.ts` | The audition bench, at `/src/game/audio/demo.html` |

## API

```ts
const audio = new AudioEngine({ lite?: boolean, quiet?: boolean, autoCores?: boolean, lookahead?: number, syncTrim?: number, prepare?: boolean });
audio.prepare();                      // called by the constructor (prepare: false to opt out): see "Startup"
await audio.unlock();                 // from a user gesture; resumes the prepared AudioContext
audio.setTitan(spec, field);          // per titan; may be called before unlock
audio.update(t, stage, hpFrac, { playing, nearDanger }); // every frame, t = synced titan time
audio.sfx(name, x?, strength?);       // x = arena x in [-8, 8] (panning)
audio.setVolume(master, music, sfx);  // 0..1 each
audio.mute(on); audio.setQuiet(on);
audio.ready();                        // resolves when the instrument bank is rendered (live synth until then)
audio.stats();                        // notes, voices, live nodes, offset, resyncs, late steps...
audio.heardTime();                    // the titan time coming out of the speakers right now
AudioEngine.renderExcerpt(spec, field, { t0, seconds, stage }); // offline render, an AudioBuffer
```

Sfx names: `start`, `dash`, `graze` (strength = number of grazes), `hurt`, `surge`, `strike` (strength 0..1), `down`, `core-open`, `felled`, `wake`, `revive`, `relight`, `ui`, `ui-hover`. `beat` is accepted and ignored, because the Canticle already keeps the beat.

## Startup

The first gesture must not stall the page (opening the book used to freeze it for 0.5-0.8 s on a laptop and 2 s on a phone). So the engine gets ready while the cover is up, in idle slices (`requestIdleCallback`, a timeout in Safari), after the page's own startup:

1. Open the AudioContext. It is held suspended until `unlock()`, even where the browser would let it run, so nothing sounds before a gesture. Opening the audio device is the one step that cannot be split (tens to hundreds of ms).
2. Build the mix graph, then the titan's drone.
3. Generate the cathedral's impulse response a slice at a time (`cathedralIRSteps`, sample-identical to `cathedralIR`) and hand it to the convolver.
4. Render the instrument bank: the shared instruments five at a time, then the titan's drums.

`unlock()` then only resumes the context (and starts the silent buffer iOS needs). If the gesture comes first, it opens the context and builds the graph itself (a few ms), the drone follows in the next task, and the cathedral and the bank follow in idle slices; until the cathedral arrives the mix is dry, and until the bank arrives the live voices play. Offline engines (`renderExcerpt`) build everything at once, as before.

## Timing

- The engine schedules each sixteenth note about 120 ms ahead on the AudioContext clock.
- Titan time maps to context time through an offset. Each frame measures that offset from `getOutputTimestamp()`, which compares the speaker clock with `performance.now()`, and smooths it (about 0.5 s time constant). The 512-frame lookahead of the two compressors is subtracted, so a note scheduled for beat `b` leaves the speakers when every other hunter's screen shows beat `b`.
- A disagreement over 60 ms causes a hard resync. So does a backward jump in `t` or a gap over 1 s. A resync never replays the past; it starts from the first sixteenth that can still be heard on time. A stall (debugger, long frame) skips its stale steps instead of bursting them.
- On a hidden tab the master fades out and the context suspends. It resumes and resyncs on return.
- Every note, tell and impact is quantised to the sixteenth grid of the titan's tempo. `syncTrim` shifts the audio if the display pipeline is unusually slow.

## The Canticle

Each titan's song comes from `rngFor("song", seed)` and its spec. The **mode**, **root** and **tempo** come straight from the spec. Two **modal progressions** (one chord per 4 bars) set the form `A A B A B A' B A`. A 2-bar **motif** and an **answer** come from the archetype's rhythm cells.

The 8 phrases of the loop develop the motif:

| Phrase | Treatment |
| --- | --- |
| 0, overture | Drone and choir alone, a footfall every other bar; the motif returns half-remembered on bells |
| 1 | Statement |
| 2 | Inversion answers it |
| 3 | Retrograde, answered by bells |
| 4 | Augmentation: slower and broader |
| 5 | A countermelody in thirds |
| 6 | Diminution: twice as fast |
| 7, crescendo | An octave up and doubled, climbing. The last 4 bars bring a frame-drum roll, rising air and bowed metal, and a choir swell into the overture's gong |

**Stage layers** (Calm, Wrath, Ruin):

| Layer | Calm | Wrath | Ruin |
| --- | --- | --- | --- |
| Choir | 3 voices, dark | 3rd voice, brighter | High octave added, open |
| Bourdon | Tonic and fifth | Plus hurdy-gurdy buzz chuffing on eighths | Louder buzz |
| Drums | Sparse | Full pattern, fills every 4th bar | Taiko flams, ghost notes, signature syncopation |
| Bass | Pedal per bar | Walking figure | Driving eighths, octave jumps, sub |
| Melody | Lead instrument | Plus a doubling instrument | Plus bell doubling on strong notes and bowed-metal swells at chord changes |

Going up a stage lands on the next bar line with a gong, a bell toll, a taiko flam and a choir swell.

**Archetypes** each have their own voice:

| Archetype | Choir vowel | Lead / doubling | Drums and feel |
| --- | --- | --- | --- |
| Coil | "aw" | Shawm / psaltery | Heavy hurdy-gurdy buzz, tresillo rhythms, swing |
| Strider | Deep "oo" | Psaltery / organ | Giant taiko footfalls, marching |
| Bloom | Bright "ih" | Bowed glass / psaltery | Many bells, light hand drums, zills |
| Throne | "ah" | Psaltery / carillon | Organ bourdon, processional timpani-like low drum |
| Swarmheart | "eh" | Shawm / psaltery | Buzz, restless sixteenth jingles |

## Dodging by ear

Every volley in `field.plan()` is voiced from the same deterministic plan the field uses:

- **Tell**, one beat before it lands, pitched in the current chord and panned to the volley's origin. The family sets the sound:
  - **Shot** (ring, spiral, fan, wave, curve, bloom): a high bell.
  - **Ground** (slam, glyph, rain): a low wooden pluck.
  - **Sweep** (beam, wall, cross): a bowed-glass tone.
  - Each kind has its own scale degree. Heavy volleys add a lower octave.
- **Swell**: heavy volleys with a 2-beat tell get a bowed-metal crescendo over the whole telegraph. The Ruin signature (3-beat tell) adds a bell toll and a choir swell.
- **Beam warning**: a beam adds two high strikes the moment its guide is drawn and a thin whistle rising through the whole telegraph (3 beats in Calm and Wrath) to the moment it fires.
- **Landing tick** on the beat: every impact (and every later wave of the same volley) gets a short, bright click (band-passed noise at 4.3 kHz with a 2-3.6 kHz ping on the chord), so "it lands on the beat" survives laptop and phone speakers.
- **Impact** on the beat, per kind. Rings clang, slams hit taiko, sub and a crash, walls flam, and fans clack per wave. Spirals unspool as an arpeggio, beams roar and sweep across the stereo field, blooms burst after their seed flies, and rain patters per drop. Heavy impacts duck the music for a moment.

In the lobby (`playing: false`) the music is muffled behind the page (low-pass 1.1 kHz), tells are silent, and impacts play at 45%.

## Player sfx

| Sfx | Sound |
| --- | --- |
| `graze` | A glass tick climbing the tonic arpeggio as the combo grows (resets after 1.4 s or on a hit), with a bell flourish every 10 |
| `strike` | A gilded bell on a chord tone, brighter with strength |
| `surge` | Bowed metal, a rising rush, then a big bell and a choir swell |
| `hurt` | A thud with a minor-second clang, and the cathedral goes muffled for half a second |
| `down` | Three falling tolls under a long muffle |
| `revive` | A psaltery arpeggio and a bell |
| `relight` | A rising peal of five bells, zills and a breath of choir: thirty clean seconds gave a light back |
| `felled` | A gong, a peal tumbling down the scale, and a Picardy major chord |
| `wake` | A gong and a bowed-metal rise into a toll |
| `core-open` | Two soft bells and zills. With `autoCores` (the default) the engine plays this on the beat each core window opens |

## Mix and CPU

- **Graph.** Channels (perc, bass, mel, bell, choir, bourdon, cue, impact, sfx) feed the reverb sends and two buses. Music goes through lobby low-pass, duck, danger duck and volume. Sfx go through their own volume. Both buses then pass a 50 Hz high-pass, a -7 dB low shelf at 130 Hz, glue compressor, makeup, limiter, a stage trim, a soft ceiling at -1.1 dBFS (a waveshaper; nothing can pass it) and master.
- **Tone for small speakers.** Laptop and phone speakers cannot play the cathedral's floor, and that energy only made the compressors pump the bells. So the low end is high-passed and shelved, the bourdon and bass channels are high-passed (90 / 55 Hz), and the voices that carry the song and the tells get a presence lift: melody +5.5 dB at 2.6 kHz, bells +5 dB at 2.4 kHz, tells +4.5 dB at 2.8 kHz, impacts +3 dB at 3 kHz, sfx +2.5 dB.
- **Loudness.** Measured on the master in a hunt (Nov 9, 24 s, autopilot): about -13.5 LUFS integrated, true peak about -2.5 dBFS. Offline excerpts (`renderExcerpt`) land between -13 and -16 LUFS; the stage trim (Calm x1.08, Ruin x0.88) keeps the stages within about 3 LU of each other. The 1-3 kHz band now sits level with the band below 330 Hz (it was 5-13 dB under).
- **Voice caps** apply per group (74 total). Important notes steal the oldest voice; others are dropped.
- **Sample bank.** Struck instruments replay from the bank (a buffer and a gain per note) and stop at about -48 dB.
- **Pan positions** are 11 shared persistent panners per channel, not a panner per note.
- **No `setTargetAtTime` on long-lived params.** It keeps a param on the per-sample path forever. Measured: it triples an oscillator's cost. Detune is never modulated either (per-sample exp2).
- **`lite: true`**: 2 s cathedral, 60% polyphony, no bell doubling or Ruin swells. Suggested for low-end phones.

## Wiring into Game.ts

```ts
import { AudioEngine } from "./audio/AudioEngine";
const audio = new AudioEngine({ lite: navigator.hardwareConcurrency <= 4 });

// first user gesture (Join the hunt, or any pointerdown/keydown on the page):
await audio.unlock();

// Game.setTitan, after this.field is built:
audio.setTitan(this.spec, this.field);

// Game.frame, once per frame, after t and stage are known:
audio.update(t, stage, this.hpFrac, { playing: this.phase === "playing", nearDanger });
//   nearDanger = 1 - clamp(touch.nearest / 1.5, 0, 1) from the player's last field touch()

// events
game.events.onSfx = (name, x, strength) => audio.sfx(name, x, strength);
```

Also call `audio.sfx("wake")` when a new titan wakes, `audio.sfx("felled")` when the world fells it, `audio.sfx("revive")` on a revive, and `audio.sfx("ui")` / `audio.sfx("ui-hover")` from buttons. Settings sliders map to `setVolume`. A "quiet" or reduced-motion preference maps to `setQuiet(true)`.
