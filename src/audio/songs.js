/**
 * Music.
 *
 * Each song is 16-step patterns plus a bar-by-bar chord sequence, played by the
 * sequencer in Audio.js. The current idiom is dark space techno: four-on-the-
 * floor kicks, an acid bass (filter-swept saw over a sine sub) running
 * sixteenths, a detuned-saw pad washing under each bar, sparse minor-key leads
 * that trail off into a feedback echo, and a four-bar cycle of noise risers and
 * sonar pings to keep the void audible between phrases.
 *
 * Tension comes from the harmony more than the tempo: nearly everything vamps
 * on Phrygian moves (i - bII, the semitone above the root) or minor chords a
 * tritone apart, which never resolve and never relax.
 *
 * Token meanings:
 *   bass   null = rest, 0 = chord root, 1 = root an octave up, n>1 = root + n
 *   arp    null = rest, otherwise an index into the current chord's intervals
 *   lead   absolute MIDI, null = rest, -1 = hold the previous note
 *   drums  1 = hit
 *
 * Song flags read by the sequencer:
 *   bassStyle: 'acid'   filter-swept saw + sub instead of the plain triangle
 *   pad: true           bar-long detuned-saw wash on the current chord
 *   fx: true            riser / sonar-ping cycle every four bars
 *   leadEcho: 0..1      how much of the lead feeds the echo bus
 *   leadDuty            pulse duty for the lead (0.5 square, 0.25 thin)
 */

const MINOR = [0, 3, 7];
const MAJOR = [0, 4, 7];
const MINOR7 = [0, 3, 7, 10];
const SUS = [0, 5, 7];

/** i - bII: the Phrygian semitone. Pure menace, never resolves. */
const PHRYGIAN_VAMP = [
  [0, MINOR7], [0, MINOR7], [1, MAJOR], [1, MAJOR],
  [0, MINOR7], [0, MINOR7], [10, MINOR], [1, MAJOR],
];

/** i - bVI - bIII - bVII: endless forward motion. */
const DRIVING_MINOR = [
  [0, MINOR7], [0, MINOR7], [8, MAJOR], [8, MAJOR],
  [3, MAJOR], [3, MAJOR], [10, MAJOR], [10, MAJOR],
];

/** i - iv - i - tritone: the unsettled one, for the hazard circuits. */
const TENSE_ORBIT = [
  [0, MINOR7], [0, MINOR7], [5, MINOR], [5, MINOR],
  [0, MINOR7], [0, MINOR7], [6, MAJOR], [1, MAJOR],
];

// Acid lines. Values are semitone offsets from the root (12 = octave pop),
// written so the filter accents on the downbeats land on roots and the
// syncopation lives in the octaves and sevenths.
const ACID_DRIVE = [0, 0, 12, 0, 0, 10, 0, 12, 0, 0, 12, 0, 3, 0, 10, 12];
const ACID_ROLL = [0, null, 0, 12, 0, null, 10, 0, 0, null, 0, 12, 3, 0, 12, 10];
const ACID_DARK = [0, 0, 0, 12, 0, 0, 3, 0, 0, 0, 0, 12, 0, 10, 3, 0];

const ARP_UP = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3];
const ARP_SPARSE = [0, null, 2, null, 1, null, 3, null, 0, null, 2, null, 1, 3, null, 2];

// Four on the floor, clap on 2 and 4, offbeat hats: the techno chassis.
const FLOOR = {
  kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
  hat: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1],
  ohat: [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
};

// The same chassis with a kick pushed onto the and-of-three: more drive.
const FLOOR_PUSH = {
  kick: [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0],
  snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
  hat: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
  ohat: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0],
};

const HALF_TIME = {
  kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0],
  snare: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
  hat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1],
  ohat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
};

/**
 * Title screen: slow, vast, expectant. Mostly pad and sub with the sonar
 * pinging into the dark; the lead is four long notes that each dissolve into
 * the echo before the next one lands.
 */
export const TITLE_SONG = {
  bpm: 96,
  key: 57,                       // A Phrygian
  chords: PHRYGIAN_VAMP,
  bassStyle: 'acid',
  pad: true,
  fx: true,
  leadEcho: 0.5,
  leadDuty: 0.25,
  bass: [0, null, null, null, 0, null, 12, null, 0, null, null, null, 10, null, null, null],
  arp: [null, null, 0, null, null, null, 2, null, null, null, 1, null, null, null, 3, null],
  lead: [
    69, -1, -1, -1, -1, -1, null, null,
    72, -1, -1, -1, -1, null, null, null,
    70, -1, -1, -1, -1, -1, null, null,
    64, -1, -1, -1, -1, -1, -1, -1,
  ],
  ...HALF_TIME,
};

const RACE_SONGS = {
  city: {
    bpm: 174,
    key: 57,                     // A minor — the neon commute
    chords: DRIVING_MINOR,
    bassStyle: 'acid',
    pad: true,
    fx: true,
    leadEcho: 0.35,
    bass: ACID_DRIVE,
    arp: ARP_SPARSE,
    lead: [
      81, null, null, 84, 86, -1, null, 84,
      81, null, 76, null, 79, -1, -1, null,
      81, null, null, 88, 87, -1, null, 84,
      86, -1, null, 81, 79, -1, -1, null,
    ],
    ...FLOOR,
  },
  ocean: {
    bpm: 166,
    key: 62,                     // D — the wide one; more echo, fewer notes
    chords: DRIVING_MINOR,
    bassStyle: 'acid',
    pad: true,
    fx: true,
    leadEcho: 0.5,
    leadDuty: 0.25,
    bass: ACID_ROLL,
    arp: ARP_SPARSE,
    lead: [
      86, -1, null, null, 89, -1, -1, null,
      85, -1, null, 81, -1, null, null, null,
      86, -1, null, null, 93, -1, -1, null,
      91, -1, null, 89, -1, -1, null, null,
    ],
    ...FLOOR,
  },
  desert: {
    bpm: 170,
    key: 55,                     // G — rolling, hypnotic
    chords: PHRYGIAN_VAMP,
    bassStyle: 'acid',
    pad: true,
    fx: true,
    leadEcho: 0.3,
    bass: ACID_DRIVE,
    arp: ARP_UP,
    lead: [
      79, null, 82, -1, 86, null, 84, null,
      79, null, 74, null, 77, -1, -1, null,
      79, null, 86, -1, 84, null, 82, null,
      80, -1, 79, null, 74, -1, -1, null,
    ],
    ...FLOOR_PUSH,
  },
  grid: {
    bpm: 178,
    key: 59,                     // B Phrygian — the mine field wants dread
    chords: PHRYGIAN_VAMP,
    bassStyle: 'acid',
    pad: true,
    fx: true,
    leadEcho: 0.4,
    leadDuty: 0.25,
    bass: ACID_DARK,
    arp: ARP_SPARSE,
    lead: [
      83, 83, null, null, 84, -1, null, null,
      83, null, 78, null, 76, -1, -1, null,
      83, 83, null, null, 90, -1, null, 88,
      84, -1, null, 83, -1, -1, null, null,
    ],
    ...FLOOR,
  },
  wind: {
    bpm: 172,
    key: 60,                     // C — high pressure, forward lean
    chords: TENSE_ORBIT,
    bassStyle: 'acid',
    pad: true,
    fx: true,
    leadEcho: 0.35,
    bass: ACID_ROLL,
    arp: ARP_SPARSE,
    lead: [
      84, null, 87, null, 91, -1, null, 89,
      87, null, 84, null, 79, -1, -1, null,
      84, null, 87, null, 90, -1, null, null,
      87, -1, 84, null, 82, -1, -1, null,
    ],
    ...FLOOR_PUSH,
  },
  fire: {
    bpm: 186,                    // the finale: fastest, darkest
    key: 58,                     // Bb Phrygian
    chords: TENSE_ORBIT,
    bassStyle: 'acid',
    pad: true,
    fx: true,
    leadEcho: 0.35,
    bass: ACID_DRIVE,
    arp: ARP_UP,
    lead: [
      82, 82, null, 85, 89, -1, null, 87,
      85, null, 82, null, 77, -1, -1, null,
      82, 82, null, 89, 94, -1, null, 92,
      89, -1, 85, null, 82, -1, -1, null,
    ],
    ...FLOOR_PUSH,
  },
};

export function songForTheme(theme) {
  return RACE_SONGS[theme] ?? RACE_SONGS.city;
}

/** Short victory fanfare data for the results screen. */
export const FANFARE = [
  [72, 0.0, 0.12], [76, 0.12, 0.12], [79, 0.24, 0.12],
  [84, 0.36, 0.5], [88, 0.36, 0.5], [91, 0.42, 0.44],
];
