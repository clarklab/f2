/**
 * Music.
 *
 * Each song is 16-step patterns plus a bar-by-bar chord sequence. The idiom is
 * deliberately specific: a minor/Dorian vamp, relentless sixteenth-note bass
 * with octave pops, and a fast arpeggio standing in for a chord — the arpeggio
 * is the chiptune trick where cycling a triad faster than the ear can separate
 * fuses into a chord, which is how a machine with three tone channels plays
 * harmony and a melody at the same time.
 *
 * Token meanings:
 *   bass   null = rest, 0 = chord root, 1 = root an octave up, n>1 = root + n
 *   arp    null = rest, otherwise an index into the current chord's intervals
 *   lead   absolute MIDI, null = rest, -1 = hold the previous note
 *   drums  1 = hit
 */

const MINOR = [0, 3, 7];
const MAJOR = [0, 4, 7];
const SUS = [0, 5, 7];

/** i - bVI - bIII - bVII: endless forward motion, never resolves. */
const DRIVING_MINOR = [
  [0, MINOR], [0, MINOR], [8, MAJOR], [8, MAJOR],
  [3, MAJOR], [3, MAJOR], [10, MAJOR], [10, MAJOR],
];

/** i - IV: the major fourth over a minor tonic is *the* Dorian racing sound. */
const DORIAN_VAMP = [
  [0, MINOR], [0, MINOR], [5, MAJOR], [5, MAJOR],
  [0, MINOR], [0, MINOR], [10, MAJOR], [7, SUS],
];

const STRAIGHT_BASS = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 7, 11];
const PUMP_BASS = [0, null, 0, 1, 0, null, 0, 1, 0, null, 0, 1, 0, 1, 0, 7];
const ARP_UP = [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 1];
const ARP_ROLL = [0, 2, 1, 2, 0, 2, 1, 2, 0, 2, 1, 2, 0, 1, 2, 1];

const BEAT = {
  kick: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0],
  snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1],
  hat: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  ohat: [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0],
};

const HALF_TIME = {
  kick: [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0],
  snare: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
  hat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1],
  ohat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
};

/** Title screen: slower, wide, expectant. */
export const TITLE_SONG = {
  bpm: 112,
  key: 60,
  chords: DRIVING_MINOR,
  bass: PUMP_BASS,
  arp: ARP_ROLL,
  lead: [
    79, null, null, 82, 84, -1, -1, null,
    82, null, 79, null, 75, -1, -1, null,
    77, null, null, 79, 82, -1, -1, null,
    79, null, 75, null, 72, -1, -1, -1,
  ],
  ...HALF_TIME,
};

const RACE_SONGS = {
  city: {
    bpm: 172,
    key: 60,                     // C Dorian
    chords: DORIAN_VAMP,
    bass: STRAIGHT_BASS,
    arp: ARP_UP,
    lead: [
      84, null, 87, null, 89, -1, 87, null,
      84, null, 79, null, 82, -1, -1, null,
      84, null, 87, null, 91, -1, 89, null,
      87, null, 84, null, 79, -1, -1, null,
    ],
    ...BEAT,
  },
  ocean: {
    bpm: 164,
    key: 62,                     // D
    chords: DORIAN_VAMP,
    bass: PUMP_BASS,
    arp: ARP_ROLL,
    lead: [
      86, null, null, 89, 91, -1, -1, 89,
      86, null, 84, null, 81, -1, -1, null,
      84, null, 86, null, 89, -1, 86, null,
      84, null, 81, null, 79, -1, -1, -1,
    ],
    ...BEAT,
  },
  desert: {
    bpm: 158,
    key: 57,                     // A
    chords: DRIVING_MINOR,
    bass: STRAIGHT_BASS,
    arp: ARP_UP,
    lead: [
      81, null, 84, -1, 88, null, 84, null,
      81, null, 76, null, 79, -1, -1, null,
      81, null, 88, -1, 86, null, 84, null,
      81, null, 79, null, 76, -1, -1, null,
    ],
    ...BEAT,
  },
  grid: {
    bpm: 178,
    key: 59,                     // B — tense
    chords: [
      [0, MINOR], [0, MINOR], [1, MAJOR], [1, MAJOR],
      [0, MINOR], [0, MINOR], [10, MAJOR], [8, MAJOR],
    ],
    bass: STRAIGHT_BASS,
    arp: ARP_ROLL,
    lead: [
      83, 83, null, 86, 88, null, 86, null,
      83, null, 81, null, 78, -1, -1, null,
      83, 83, null, 88, 90, null, 88, null,
      86, null, 83, null, 81, -1, -1, null,
    ],
    ...BEAT,
  },
  wind: {
    bpm: 168,
    key: 55,                     // G
    chords: DORIAN_VAMP,
    bass: PUMP_BASS,
    arp: ARP_UP,
    lead: [
      79, null, 82, null, 86, -1, -1, 84,
      82, null, 79, null, 74, -1, -1, null,
      77, null, 79, null, 82, -1, -1, null,
      79, null, 74, null, 72, -1, -1, -1,
    ],
    ...BEAT,
  },
  fire: {
    bpm: 184,                    // the finale, and the fastest
    key: 58,
    chords: [
      [0, MINOR], [0, MINOR], [8, MAJOR], [7, MAJOR],
      [0, MINOR], [3, MAJOR], [10, MAJOR], [7, MAJOR],
    ],
    bass: STRAIGHT_BASS,
    arp: ARP_ROLL,
    lead: [
      82, 82, null, 85, 89, -1, 87, null,
      85, null, 82, null, 77, -1, -1, null,
      82, 82, null, 89, 92, -1, 90, null,
      89, null, 85, null, 82, -1, -1, null,
    ],
    ...BEAT,
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
