// Rule-based English grapheme-to-phoneme conversion for lip-sync (no dictionary download, no
// network): the system voice (Web Speech) gives us the words and their boundary times but no
// phonemes, so the mouth shapes are predicted from the spelling.
//
//   1. an exception dictionary of the most common English words, contractions and a few names
//      ("Claude", "Anthropic"), with stress (ARPAbet as in CMUdict: AH0 = unstressed schwa);
//   2. the NRL letter-to-sound rules (Elovitz, Johnson, McHugh & Shore, "Automatic translation
//      of English text to phonetics by means of letter-to-sound rules", NRL report 7948, 1976;
//      public domain) for every other word, plus a light stress heuristic;
//   3. numbers, ordinals and acronyms are expanded the way a voice reads them.
//
// The output only drives the mouth, so "good enough to look right" is the bar: a wrong vowel
// colour costs little, a missing m/b/p closure or f/v tuck is what people notice.

/** ARPAbet phonemes used here (CMUdict set). */
export const VOWELS = Object.freeze(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);
export const CONSONANTS = Object.freeze([
  'B', 'CH', 'D', 'DH', 'F', 'G', 'HH', 'JH', 'K', 'L', 'M', 'N', 'NG', 'P', 'R', 'S', 'SH', 'T', 'TH', 'V', 'W', 'Y', 'Z', 'ZH',
]);
const VOWEL_SET = new Set(VOWELS);

/**
 * @typedef {{ ph: string, stress: number }} Phone   stress: 0 none, 1 primary, 2 secondary (vowels only)
 * @typedef {{ text: string, start: number, end: number, phones: Phone[], punct: string, content: boolean,
 *             emphasis: boolean }} WordPron
 *   start/end: character offsets in the source text; punct: punctuation that follows the word
 *   ('' none, else one of , ; : . ! ? —); content: a content word (carries pitch accents).
 */

// ---------------------------------------------------------------------------------------------
// Exception dictionary (CMUdict pronunciations). Function words carry stress 0: in connected
// speech they are unstressed, which keeps the jaw small and the nods on the content words.
// ---------------------------------------------------------------------------------------------
const DICT_SRC = `
a:AH0|about:AH0 B AW1 T|above:AH0 B AH1 V|after:AE1 F T ER0|again:AH0 G EH1 N|against:AH0 G EH1 N S T
ago:AH0 G OW1|ah:AA1|ai:EY1 AY1|all:AO1 L|almost:AO1 L M OW2 S T|already:AO0 L R EH1 D IY0|also:AO1 L S OW0
although:AO2 L DH OW1|always:AO1 L W EY2 Z|am:AE0 M|an:AE0 N|and:AH0 N D|another:AH0 N AH1 DH ER0
answer:AE1 N S ER0|anthropic:AE2 N TH R AA1 P IH0 K|any:EH1 N IY0|anyone:EH1 N IY0 W AH2 N
anything:EH1 N IY0 TH IH2 NG|are:AA0 R|area:EH1 R IY0 AH0|aren't:AA1 R AH0 N T|around:ER0 AW1 N D
as:AE0 Z|ask:AE1 S K|at:AE0 T|avatar:AE1 V AH0 T AA2 R|away:AH0 W EY1|back:B AE1 K|bad:B AE1 D
be:B IY0|became:B IH0 K EY1 M|because:B IH0 K AO1 Z|been:B IH0 N|before:B IH0 F AO1 R|began:B IH0 G AE1 N
being:B IY1 IH0 NG|best:B EH1 S T|better:B EH1 T ER0|between:B IH0 T W IY1 N|big:B IH1 G
billion:B IH1 L Y AH0 N|body:B AA1 D IY0|both:B OW1 TH|build:B IH1 L D|busy:B IH1 Z IY0|but:B AH0 T
button:B AH1 T AH0 N|by:B AY0|bye:B AY1|call:K AO1 L|came:K EY1 M|camera:K AE1 M ER0 AH0|can:K AE0 N
can't:K AE1 N T|cannot:K AE1 N AA0 T|car:K AA1 R|case:K EY1 S|child:CH AY1 L D|children:CH IH1 L D R AH0 N
city:S IH1 T IY0|claude:K L AO1 D|click:K L IH1 K|close:K L OW1 Z|code:K OW1 D|come:K AH1 M
company:K AH1 M P AH0 N IY0|computer:K AH0 M P Y UW1 T ER0|cool:K UW1 L|could:K UH0 D|couldn't:K UH1 D AH0 N T
country:K AH1 N T R IY0|data:D EY1 T AH0|day:D EY1|desktop:D EH1 S K T AA2 P|did:D IH1 D|didn't:D IH1 D AH0 N T
different:D IH1 F ER0 AH0 N T|do:D UW0|does:D AH1 Z|doesn't:D AH1 Z AH0 N T|doing:D UW1 IH0 NG
dollars:D AA1 L ER0 Z|don't:D OW1 N T|done:D AH1 N|door:D AO1 R|down:D AW1 N|each:IY1 CH|early:ER1 L IY0
eight:EY1 T|eighteen:EY0 T IY1 N|eighty:EY1 T IY0|either:IY1 DH ER0|eleven:IH0 L EH1 V AH0 N|else:EH1 L S
email:IY1 M EY2 L|english:IH1 NG G L IH0 SH|enough:IH0 N AH1 F|error:EH1 R ER0|even:IY1 V IH0 N
ever:EH1 V ER0|every:EH1 V R IY0|everybody:EH1 V R IY0 B AA2 D IY0|everyone:EH1 V R IY0 W AH2 N
everything:EH1 V R IY0 TH IH2 NG|eye:AY1|eyes:AY1 Z|face:F EY1 S|fact:F AE1 K T|family:F AE1 M AH0 L IY0
far:F AA1 R|father:F AA1 DH ER0|feel:F IY1 L|feeling:F IY1 L IH0 NG|felt:F EH1 L T|few:F Y UW1
fifteen:F IH0 F T IY1 N|fifty:F IH1 F T IY0|file:F AY1 L|files:F AY1 L Z|find:F AY1 N D|fine:F AY1 N
first:F ER1 S T|five:F AY1 V|folder:F OW1 L D ER0|for:F AO0 R|forty:F AO1 R T IY0|found:F AW1 N D
four:F AO1 R|fourteen:F AO1 R T IY1 N|friend:F R EH1 N D|friends:F R EH1 N D Z|from:F R AH0 M
game:G EY1 M|gave:G EY1 V|get:G EH1 T|getting:G EH1 T IH0 NG|github:G IH1 T HH AH2 B|give:G IH1 V
glad:G L AE1 D|go:G OW1|going:G OW1 IH0 NG|gone:G AO1 N|good:G UH1 D|goodbye:G UH2 D B AY1|got:G AA1 T
great:G R EY1 T|group:G R UW1 P|had:HH AE0 D|half:HH AE1 F|hand:HH AE1 N D|happy:HH AE1 P IY0
has:HH AE0 Z|have:HH AE0 V|haven't:HH AE1 V AH0 N T|having:HH AE1 V IH0 NG|he:HH IY0|he's:HH IY0 Z
head:HH EH1 D|hear:HH IY1 R|heard:HH ER1 D|heart:HH AA1 R T|hello:HH AH0 L OW1|help:HH EH1 L P
her:HH ER0|here:HH IY1 R|here's:HH IH1 R Z|hey:HH EY1|hi:HH AY1|high:HH AY1|him:HH IH0 M|his:HH IH0 Z
hmm:HH AH0 M|home:HH OW1 M|hour:AW1 ER0|hours:AW1 ER0 Z|house:HH AW1 S|how:HH AW1|however:HH AW2 EH1 V ER0
hundred:HH AH1 N D R AH0 D|i:AY0|i'd:AY0 D|i'll:AY0 L|i'm:AY0 M|i've:AY0 V|idea:AY0 D IY1 AH0|if:IH0 F
important:IH0 M P AO1 R T AH0 N T|in:IH0 N|information:IH2 N F ER0 M EY1 SH AH0 N|install:IH0 N S T AO1 L
into:IH1 N T UW0|is:IH0 Z|isn't:IH1 Z AH0 N T|it:IH0 T|it's:IH0 T S|its:IH0 T S|javascript:JH AA1 V AH0 S K R IH2 P T
just:JH AH1 S T|keep:K IY1 P|kept:K EH1 P T|kind:K AY1 N D|knew:N UW1|know:N OW1|language:L AE1 NG G W AH0 JH
large:L AA1 R JH|last:L AE1 S T|lawnmower:L AO1 N M OW2 ER0|left:L EH1 F T|let:L EH1 T|let's:L EH1 T S
life:L AY1 F|like:L AY1 K|linux:L IH1 N AH0 K S|listen:L IH1 S AH0 N|little:L IH1 T AH0 L|long:L AO1 NG
look:L UH1 K|looking:L UH1 K IH0 NG|love:L AH1 V|made:M EY1 D|make:M EY1 K|making:M EY1 K IH0 NG
man:M AE1 N|many:M EH1 N IY0|may:M EY1|maybe:M EY1 B IY0|me:M IY0|mean:M IY1 N|meant:M EH1 N T|men:M EH1 N
message:M EH1 S AH0 JH|microphone:M AY1 K R AH0 F OW2 N|might:M AY1 T|million:M IH1 L Y AH0 N|mind:M AY1 N D
minute:M IH1 N AH0 T|minutes:M IH1 N AH0 T S|model:M AA1 D AH0 L|money:M AH1 N IY0|more:M AO1 R
morning:M AO1 R N IH0 NG|most:M OW1 S T|mother:M AH1 DH ER0|mouse:M AW1 S|much:M AH1 CH|music:M Y UW1 Z IH0 K
must:M AH1 S T|my:M AY0|name:N EY1 M|need:N IY1 D|neither:N IY1 DH ER0|never:N EH1 V ER0|new:N UW1
next:N EH1 K S T|nice:N AY1 S|night:N AY1 T|nine:N AY1 N|nineteen:N AY1 N T IY1 N|ninety:N AY1 N T IY0
no:N OW1|nobody:N OW1 B AA2 D IY0|not:N AA1 T|nothing:N AH1 TH IH0 NG|now:N AW1|number:N AH1 M B ER0
of:AH0 V|off:AO1 F|often:AO1 F AH0 N|oh:OW1|ok:OW2 K EY1|okay:OW2 K EY1|old:OW1 L D|on:AA0 N|once:W AH1 N S
one:W AH1 N|only:OW1 N L IY0|open:OW1 P AH0 N|opus:OW1 P AH0 S|or:AO0 R|other:AH1 DH ER0|our:AW1 ER0
out:AW1 T|over:OW1 V ER0|own:OW1 N|part:P AA1 R T|people:P IY1 P AH0 L|percent:P ER0 S EH1 N T
place:P L EY1 S|please:P L IY1 Z|point:P OY1 N T|problem:P R AA1 B L AH0 M|program:P R OW1 G R AE2 M
put:P UH1 T|python:P AY1 TH AA0 N|question:K W EH1 S CH AH0 N|questions:K W EH1 S CH AH0 N Z|quite:K W AY1 T
read:R IY1 D|real:R IY1 L|really:R IH1 L IY0|right:R AY1 T|room:R UW1 M|run:R AH1 N|said:S EH1 D
same:S EY1 M|saw:S AO1|say:S EY1|school:S K UW1 L|screen:S K R IY1 N|second:S EH1 K AH0 N D
seconds:S EH1 K AH0 N D Z|see:S IY1|seem:S IY1 M|sentence:S EH1 N T AH0 N S|service:S ER1 V AH0 S|set:S EH1 T
settings:S EH1 T IH0 NG Z|seven:S EH1 V AH0 N|seventeen:S EH1 V AH0 N T IY1 N|seventy:S EH1 V AH0 N T IY0
shall:SH AE0 L|she:SH IY0|she's:SH IY0 Z|should:SH UH0 D|shouldn't:SH UH1 D AH0 N T|show:SH OW1|side:S AY1 D
since:S IH1 N S|six:S IH1 K S|sixteen:S IH0 K S T IY1 N|sixty:S IH1 K S T IY0|small:S M AO1 L|so:S OW1
some:S AH0 M|somebody:S AH1 M B AA2 D IY0|someone:S AH1 M W AH2 N|something:S AH1 M TH IH0 NG
sometimes:S AH1 M T AY2 M Z|sonnet:S AA1 N AH0 T|sorry:S AA1 R IY0|sound:S AW1 N D|speak:S P IY1 K
speech:S P IY1 CH|start:S T AA1 R T|still:S T IH1 L|story:S T AO1 R IY0|such:S AH1 CH|sure:SH UH1 R
system:S IH1 S T AH0 M|take:T EY1 K|talk:T AO1 K|talking:T AO1 K IH0 NG|tell:T EH1 L|ten:T EH1 N
test:T EH1 S T|text:T EH1 K S T|than:DH AE0 N|thank:TH AE1 NG K|thanks:TH AE1 NG K S|that:DH AE0 T
that's:DH AE0 T S|the:DH AH0|their:DH EH0 R|them:DH EH0 M|then:DH EH0 N|there:DH EH0 R|there's:DH EH0 R Z
these:DH IY0 Z|they:DH EY0|they're:DH EH0 R|thing:TH IH1 NG|things:TH IH1 NG Z|think:TH IH1 NG K
thinking:TH IH1 NG K IH0 NG|third:TH ER1 D|thirteen:TH ER1 T IY1 N|thirty:TH ER1 D IY0|this:DH IH0 S
those:DH OW1 Z|though:DH OW1|thought:TH AO1 T|thousand:TH AW1 Z AH0 N D|three:TH R IY1|through:TH R UW1
time:T AY1 M|to:T UW0|today:T AH0 D EY1|together:T AH0 G EH1 DH ER0|told:T OW1 L D|tomorrow:T AH0 M AA1 R OW2
took:T UH1 K|true:T R UW1|try:T R AY1|twelve:T W EH1 L V|twenty:T W EH1 N T IY0|twice:T W AY1 S|two:T UW1
um:AH1 M|under:AH1 N D ER0|until:AH0 N T IH1 L|up:AH1 P|upon:AH0 P AA1 N|us:AH0 S|use:Y UW1 Z|user:Y UW1 Z ER0
very:V EH1 R IY0|voice:V OY1 S|want:W AA1 N T|was:W AA0 Z|wasn't:W AA1 Z AH0 N T|watch:W AA1 CH
water:W AO1 T ER0|way:W EY1|we:W IY0|we'll:W IY0 L|we're:W IH0 R|we've:W IY0 V|weather:W EH1 DH ER0
week:W IY1 K|welcome:W EH1 L K AH0 M|well:W EH1 L|went:W EH1 N T|were:W ER0|what:W AH0 T|what's:W AH0 T S
when:W EH0 N|where:W EH1 R|whether:W EH1 DH ER0|which:W IH0 CH|while:W AY1 L|who:HH UW0|whole:HH OW1 L
why:W AY1|will:W IH0 L|window:W IH1 N D OW0|windows:W IH1 N D OW0 Z|with:W IH0 DH|without:W IH0 TH AW1 T
woman:W UH1 M AH0 N|women:W IH1 M AH0 N|won't:W OW1 N T|word:W ER1 D|words:W ER1 D Z|work:W ER1 K
working:W ER1 K IH0 NG|world:W ER1 L D|would:W UH0 D|wouldn't:W UH1 D AH0 N T|wow:W AW1|write:R AY1 T
yeah:Y AE1|year:Y IH1 R|years:Y IH1 R Z|yes:Y EH1 S|yesterday:Y EH1 S T ER0 D EY2|yet:Y EH1 T|you:Y UW0
you'd:Y UW0 D|you'll:Y UW0 L|you're:Y UH0 R|you've:Y UW0 V|young:Y AH1 NG|your:Y AO0 R|yours:Y UH1 R Z
zero:Z IY1 R OW0
blood:B L AH1 D|break:B R EY1 K|built:B IH1 L T|buy:B AY1|cough:K AO1 F|earth:ER1 TH|floor:F L AO1 R
food:F UW1 D|foot:F UH1 T|full:F UH1 L|giant:JH AY1 AH0 N T|guy:G AY1|laugh:L AE1 F|learn:L ER1 N|lose:L UW1 Z
machine:M AH0 SH IY1 N|move:M UW1 V|ocean:OW1 SH AH0 N|poor:P UH1 R|prove:P R UW1 V|pull:P UH1 L|push:P UH1 SH
rough:R AH1 F|says:S EH1 Z|special:S P EH1 SH AH0 L|sugar:SH UH1 G ER0|tough:T AH1 F|whose:HH UW1 Z
`;

/** @type {Map<string, Phone[]>} */
export const DICTIONARY = new Map();
for (const entry of DICT_SRC.split(/[|\n]/)) {
  const e = entry.trim();
  if (!e) continue;
  const i = e.indexOf(':');
  DICTIONARY.set(e.slice(0, i), parsePhones(e.slice(i + 1)));
}

/** "HH AH0 L OW1" → phones. @param {string} s @returns {Phone[]} */
export function parsePhones(s) {
  return s.trim().split(/\s+/).filter(Boolean).map((p) => {
    const m = /^([A-Z]+)([012])?$/.exec(p);
    if (!m) throw new Error(`bad phoneme "${p}"`);
    return { ph: m[1], stress: m[2] ? Number(m[2]) : 0 };
  });
}

/** Function words: no pitch accent (they are also unstressed in the dictionary). */
const FUNCTION_WORDS = new Set((
  'a an the and or but if so as at by for from in into of off on onto out over to up with without about '
  + 'i me my mine we us our you your he him his she her it its they them their this that these those '
  + 'am is are was were be been being have has had do does did will would shall should can could may might must '
  + "i'm i'll i'd i've you're you'll you've we're we'll he's she's it's that's there's they're what's let's "
  + 'than then there here when where which who whom whose what how not no just very really quite'
).split(/\s+/));

/** Intensifiers that a speaker stresses (brow raise + a firmer nod). */
const EMPHATIC = new Set(['very', 'really', 'absolutely', 'totally', 'never', 'always', 'amazing', 'love', 'definitely',
  'incredibly', 'extremely', 'huge', 'awesome', 'wonderful', 'fantastic', 'perfect', 'exactly', 'so']);

// ---------------------------------------------------------------------------------------------
// NRL letter-to-sound rules. Each rule is "left[match]right=PHONEMES". Context symbols:
//   ' ' word boundary   # one or more vowels   : zero or more consonants   ^ one consonant
//   . a voiced consonant (B D V G J L M N R W Z)   + a front vowel (E I Y)
//   % a suffix (E, ER, ES, ED, ING, ELY)   & a sibilant (S C G Z X J CH SH)
//   @ a consonant that makes a following U long (T S R D L Z N J TH CH SH)
// Rules for a letter are tried in order; the first whose contexts match wins.
// ---------------------------------------------------------------------------------------------
const RULE_SRC = {
  A: [
    ' [A] =AH', ' [ARE] =AA R', ' [AR]O=AH R', '[AR]#=EH R', ' ^[AS]#=EY S', '[A]WA=AH', '[AW]=AO',
    ' :[ANY]=EH N IY', '[A]^+#=EY', '#:[ALLY]=AH L IY', ' [AL]#=AH L', '[AGAIN]=AH G EH N', '#:[AG]E=IH JH',
    '[A]^+:#=AE', ' :[A]^+ =EY', '[A]^%=EY', ' [ARR]=AH R', '[ARR]=AE R', ' :[AR] =AA R', '[AR] =ER',
    '[AR]=AA R', '[AIR]=EH R', '[AI]=EY', '[AY]=EY', '[AU]=AO', '#:[AL] =AH L', '#:[ALS] =AH L Z',
    '[ALK]=AO K', '[AL]^=AO L', ' :[ABLE]=EY B AH L', '[ABLE]=AH B AH L', '[ANG]+=EY N JH', '[A]=AE',
  ],
  B: [' [BE]^#=B IH', '[BEING]=B IY IH NG', ' [BOTH] =B OW TH', ' [BUS]#=B IH Z', '[BUIL]=B IH L', '[B]=B'],
  C: [
    ' [CH]^=K', '^E[CH]=K', '[CH]=CH', ' S[CI]#=S AY', '[CI]A=SH', '[CI]O=SH', '[CI]EN=SH', '[C]+=S',
    '[CK]=K', '[COM]%=K AH M', '[C]=K',
  ],
  D: [
    '#:[DED] =D IH D', '.E[D] =D', '#^:E[D] =T', ' [DE]^#=D IH', ' [DO] =D UW', ' [DOES]=D AH Z',
    ' [DOING]=D UW IH NG', ' [DOW]=D AW', '[DU]A=JH UW', '[D]=D',
  ],
  E: [
    '#:[E] =', "'^:[E] =", ' :[E] =IY', '#[ED] =D', '#:[E]D =', '[EV]ER=EH V', '[E]^%=IY', '[ERI]#=IY R IY',
    '[ERI]=EH R IH', '#:[ER]#=ER', '[ER]#=EH R', '[ER]=ER', ' [EVEN]=IY V EH N', '#:[E]W=', '@[EW]=UW',
    '[EW]=Y UW', '[E]O=IY', '#:&[ES] =IH Z', '#:[E]S =', '#:[ELY] =L IY', '#:[EMENT]=M EH N T',
    '[EFUL]=F UH L', '[EE]=IY', '[EARN]=ER N', ' [EAR]^=ER', '[EAD]=EH D', '#:[EA] =IY AH', '[EA]SU=EH',
    '[EA]=IY', '[EIGH]=EY', '[EI]=IY', ' [EYE]=AY', '[EY]=IY', '[EU]=Y UW', '[E]=EH',
  ],
  F: ['[FUL]=F UH L', '[F]=F'],
  G: [
    '[GIV]=G IH V', ' [G]I^=G', '[GE]T=G EH', 'SU[GGES]=G JH EH S', '[GG]=G', ' B#[G]=G', '[G]+=JH',
    '[GREAT]=G R EY T', '#[GH]=', '[G]=G',
  ],
  H: [' [HAV]=HH AE V', ' [HERE]=HH IY R', ' [HOUR]=AW ER', '[HOW]=HH AW', '[H]#=HH', '[H]='],
  I: [
    ' [IN]=IH N', ' [I] =AY', '[IN]D=AY N', '[IER]=IY ER', '#:R[IED] =IY D', '[IED] =AY D', '[IEN]=IY EH N',
    '[IE]T=AY EH', ' :[I]%=AY', '[I]%=IY', '[IE]=IY', '[I]^+:#=IH', '[IR]#=AY R', '[IZ]%=AY Z', '[IS]%=AY Z',
    '[I]D%=AY', '+^[I]^+=IH', '[I]T%=AY', '#^:[I]^+=IH', '[I]^+=AY', '[IR]=ER', '[IGH]=AY', '[ILD]=AY L D',
    '[IGN] =AY N', '[IGN]^=AY N', '[IGN]%=AY N', '[IQUE]=IY K', '[I]=IH',
  ],
  J: ['[J]=JH'],
  K: [' [K]N=', '[K]=K'],
  L: ['[LO]C#=L OW', 'L[L]=', '#^:[L]%=AH L', '[LEAD]=L IY D', '[L]=L'],
  M: ['[MOV]=M UW V', '[M]=M'],
  N: ['E[NG]+=N JH', '[NG]R=NG G', '[NG]#=NG G', '[NGL]%=NG G AH L', '[NG]=NG', '[NK]=NG K', ' [NOW] =N AW', '[N]=N'],
  O: [
    '[OF] =AH V', '[OROUGH]=ER OW', '#:[OR] =ER', '#:[ORS] =ER Z', '[OR]=AO R', ' [ONE]=W AH N', '[OW]=OW',
    ' [OVER]=OW V ER', '[OV]=AH V', '[O]^%=OW', '[O]^EN=OW', '[O]^I#=OW', '[OL]D=OW L', '[OUGHT]=AO T',
    '[OUGH]=AH F', ' [OU]=AW', 'H[OU]S#=AW', '[OUS]=AH S', '[OUR]=AO R', '[OULD]=UH D', '^[OU]^L=AH',
    '[OUP]=UW P', '[OU]=AW', '[OY]=OY', '[OING]=OW IH NG', '[OI]=OY', '[OOR]=AO R', '[OOK]=UH K',
    '[OOD]=UH D', '[OO]=UW', '[O]E=OW', '[O] =OW', '[OA]=OW', ' [ONLY]=OW N L IY', ' [ONCE]=W AH N S',
    "[ON'T]=OW N T", 'C[O]N=AA', '[O]NG=AO', ' :^[O]N=AH', 'I[ON]=AH N', '#:[ON] =AH N', '#^[ON]=AH N',
    '[O]ST =OW', '[OF]^=AO F', '[OTHER]=AH DH ER', '[OSS] =AO S', '#^:[OM]=AH M', '[O]=AA',
  ],
  P: ['[PH]=F', '[PEOP]=P IY P', '[POW]=P AW', '[PUT] =P UH T', '[P]=P'],
  Q: ['[QUAR]=K W AO R', '[QU]=K W', '[Q]=K'],
  R: [' [RE]^#=R IY', '[R]=R'],
  S: [
    '[SH]=SH', '#[SION]=ZH AH N', '[SOME]=S AH M', '#[SUR]#=ZH ER', '[SUR]#=SH ER', '#[SU]#=ZH UW',
    '#[SSU]#=SH UW', '#[SED] =Z D', '#[S]#=Z', '[SAID]=S EH D', '^[SION]=SH AH N', '[S]S=', '.[S] =Z',
    '#:.E[S] =Z', '#^:##[S] =Z', '#^:#[S] =S', 'U[S] =S', ' :#[S] =Z', ' [SCH]=S K', '[S]C+=', '#[SM]=Z M',
    "#[SN]'=Z AH N", '[S]=S',
  ],
  T: [
    ' [THE] =DH AH', '[TO] =T UW', '[THAT] =DH AE T', ' [THIS] =DH IH S', ' [THEY]=DH EY', ' [THERE]=DH EH R',
    '[THER]=DH ER', '[THEIR]=DH EH R', ' [THAN] =DH AE N', ' [THEM] =DH EH M', '[THESE] =DH IY Z',
    ' [THEN]=DH EH N', '[THROUGH]=TH R UW', '[THOSE]=DH OW Z', '[THOUGH] =DH OW', ' [THUS]=DH AH S', '[TH]=TH',
    '#:[TED] =T IH D', 'S[TI]#N=CH', '[TI]O=SH', '[TI]A=SH', '[TIEN]=SH AH N', '[TUR]#=CH ER', '[TU]A=CH UW',
    ' [TWO]=T UW', '[T]=T',
  ],
  U: [
    ' [UN]I=Y UW N', ' [UN]=AH N', ' [UPON]=AH P AO N', '@[UR]#=UH R', '[UR]#=Y UH R', '[UR]=ER', '[U]^ =AH',
    '[U]^^=AH', '[UY]=AY', ' G[U]#=', 'G[U]%=', 'G[U]#=W', '#N[U]=Y UW', '@[U]=UW', '[U]=Y UW',
  ],
  V: ['[VIEW]=V Y UW', '[V]=V'],
  W: [
    ' [WERE]=W ER', '[WA]S=W AA', '[WA]T=W AA', '[WHERE]=W EH R', '[WHAT]=W AA T', '[WHOL]=HH OW L', '[WHO]=HH UW',
    '[WH]=W', '[WAR]=W AO R', '[WOR]^=W ER', '[WR]=R', '[W]=W',
  ],
  X: ['[X]=K S'],
  Y: [
    '[YOUNG]=Y AH NG', ' [YOU]=Y UW', ' [YES]=Y EH S', ' [Y]=Y', '#^:[Y] =IY', '#^:[Y]I=IY', ' :[Y] =AY',
    ' :[Y]#=AY', ' :[Y]^+:#=IH', ' :[Y]^#=AY', '[Y]=IH',
  ],
  Z: ['[Z]=Z'],
  "'": ["[']="],
};

/** @typedef {{ left: string, match: string, right: string, out: string[] }} Rule */
/** @type {Record<string, Rule[]>} */
const RULES = {};
for (const [letter, list] of Object.entries(RULE_SRC)) {
  RULES[letter] = list.map((src) => {
    const m = /^(.*)\[(.+)\](.*)=(.*)$/.exec(src);
    if (!m) throw new Error(`bad rule ${src}`);
    return { left: m[1], match: m[2], right: m[3], out: m[4].trim() ? m[4].trim().split(/\s+/) : [] };
  });
}

const isLetter = (c) => c >= 'A' && c <= 'Z';
const isVowelL = (c) => c === 'A' || c === 'E' || c === 'I' || c === 'O' || c === 'U';
const isConsL = (c) => isLetter(c) && !isVowelL(c);
const VOICED = new Set('BDVGJLMNRWZ');
const FRONT = new Set('EIY');

/** Right context match from position j (text is ' WORD ' upper case). */
function matchRight(pat, text, j) {
  for (let k = 0; k < pat.length; k++) {
    const p = pat[k];
    const c = text[j] || ' ';
    switch (p) {
      case ' ': if (isLetter(c)) return false; j++; break;
      case '#': if (!isVowelL(c)) return false; while (isVowelL(text[j] || '')) j++; break;
      case ':': while (isConsL(text[j] || '')) j++; break;
      case '^': if (!isConsL(c)) return false; j++; break;
      case '.': if (!VOICED.has(c)) return false; j++; break;
      case '+': if (!FRONT.has(c)) return false; j++; break;
      case '%': {
        if (c === 'E') {
          const n = text[j + 1] || ' ';
          if (n === 'R' || n === 'S' || n === 'D') j += 2;
          else if (n === 'L' && text[j + 2] === 'Y') j += 3;
          else j += 1;
        } else if (text.startsWith('ING', j)) j += 3;
        else return false;
        break;
      }
      case '&':
        if (text.startsWith('CH', j) || text.startsWith('SH', j)) j += 2;
        else if ('SCGZXJ'.includes(c) && c !== ' ') j++;
        else return false;
        break;
      case '@':
        if (text.startsWith('TH', j) || text.startsWith('CH', j) || text.startsWith('SH', j)) j += 2;
        else if ('TSRDLZNJ'.includes(c) && c !== ' ') j++;
        else return false;
        break;
      default: if (c !== p) return false; j++;
    }
  }
  return true;
}

/** Left context match ending at position j (scanning backwards). */
function matchLeft(pat, text, j) {
  for (let k = pat.length - 1; k >= 0; k--) {
    const p = pat[k];
    const c = j >= 0 ? text[j] : ' ';
    switch (p) {
      case ' ': if (isLetter(c)) return false; j--; break;
      case '#': if (!isVowelL(c)) return false; while (j >= 0 && isVowelL(text[j])) j--; break;
      case ':': while (j >= 0 && isConsL(text[j])) j--; break;
      case '^': if (!isConsL(c)) return false; j--; break;
      case '.': if (!VOICED.has(c)) return false; j--; break;
      case '+': if (!FRONT.has(c)) return false; j--; break;
      case '&':
        if (c === 'H' && j > 0 && (text[j - 1] === 'C' || text[j - 1] === 'S')) j -= 2;
        else if ('SCGZXJ'.includes(c) && c !== ' ') j--;
        else return false;
        break;
      case '@':
        if (c === 'H' && j > 0 && 'TCS'.includes(text[j - 1])) j -= 2;
        else if ('TSRDLZNJ'.includes(c) && c !== ' ') j--;
        else return false;
        break;
      default: if (c !== p) return false; j--;
    }
  }
  return true;
}

/**
 * Letter-to-sound rules for one word (letters and apostrophes only). Phonemes without stress.
 * @param {string} word @returns {string[]}
 */
export function letterToSound(word) {
  const w = String(word || '').toUpperCase().replace(/[^A-Z']/g, '');
  const text = ` ${w} `;
  const out = [];
  let i = 1;
  while (i < text.length - 1) {
    const c = text[i];
    const rules = RULES[c];
    let done = false;
    if (rules) {
      for (const r of rules) {
        if (!text.startsWith(r.match, i)) continue;
        if (!matchLeft(r.left, text, i - 1)) continue;
        if (!matchRight(r.right, text, i + r.match.length)) continue;
        out.push(...r.out);
        i += r.match.length;
        done = true;
        break;
      }
    }
    if (!done) i++; // no rule (should not happen for A-Z): skip the letter
  }
  return out;
}

const PREFIXES = ['un', 're', 'de', 'be', 'pre', 'dis', 'mis', 'con', 'com', 'ex', 'in', 'im', 'a'];
/** Suffixes that pull the stress onto the syllable before them. */
const PRE_STRESS_SUFFIXES = ['tion', 'sion', 'cian', 'ic', 'ical', 'ity', 'ian', 'ious', 'eous', 'ial'];

/**
 * Pick the stressed vowel of a rule-derived word (heuristic: English mostly stresses the first
 * syllable; a short unstressed prefix shifts it to the root; -tion/-ic/-ity pull it forward).
 * @param {string} word lower case @param {string[]} phs @returns {Phone[]}
 */
export function assignStress(word, phs) {
  const nuclei = [];
  phs.forEach((p, i) => { if (VOWEL_SET.has(p)) nuclei.push(i); });
  let primary = 0;
  if (nuclei.length >= 2) {
    const suf = PRE_STRESS_SUFFIXES.find((s) => word.endsWith(s) && word.length > s.length + 2);
    if (suf) {
      // syllables of the suffix ('tion' = 1, 'ical' = 2, 'ity' = 2) → stress the one before it
      const sufSyl = Math.max(1, (suf.match(/[aeiouy]+/g) || []).length - (suf === 'ious' || suf === 'eous' || suf === 'ial' || suf === 'ian' ? 1 : 0));
      primary = Math.max(0, nuclei.length - 1 - sufSyl);
    } else if (PREFIXES.some((p) => word.startsWith(p) && word.length > p.length + 3) && nuclei.length <= 3) {
      primary = 1;
    }
  }
  return phs.map((ph, i) => ({ ph, stress: VOWEL_SET.has(ph) ? (nuclei[primary] === i ? 1 : 0) : 0 }));
}

const LETTER_NAMES = {
  a: 'EY1', b: 'B IY1', c: 'S IY1', d: 'D IY1', e: 'IY1', f: 'EH1 F', g: 'JH IY1', h: 'EY1 CH', i: 'AY1',
  j: 'JH EY1', k: 'K EY1', l: 'EH1 L', m: 'EH1 M', n: 'EH1 N', o: 'OW1', p: 'P IY1', q: 'K Y UW1', r: 'AA1 R',
  s: 'EH1 S', t: 'T IY1', u: 'Y UW1', v: 'V IY1', w: 'D AH1 B AH0 L Y UW0', x: 'EH1 K S', y: 'W AY1', z: 'Z IY1',
};

/** Spell a token letter by letter (acronyms: "GPU", "API"). @param {string} s @returns {Phone[]} */
export function spell(s) {
  const out = [];
  for (const ch of String(s).toLowerCase()) if (LETTER_NAMES[ch]) out.push(...parsePhones(LETTER_NAMES[ch]));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** Integer → English words ("one hundred twenty three"). @param {number} n @returns {string[]} */
export function numberWords(n) {
  n = Math.floor(Math.abs(n));
  if (n < 20) return [ONES[n]];
  if (n < 100) return n % 10 ? [TENS[Math.floor(n / 10)], ONES[n % 10]] : [TENS[n / 10]];
  if (n < 1000) return [ONES[Math.floor(n / 100)], 'hundred', ...(n % 100 ? numberWords(n % 100) : [])];
  for (const [size, name] of /** @type {Array<[number, string]>} */ ([[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']])) {
    if (n >= size) {
      const rest = n % size;
      return [...numberWords(Math.floor(n / size)), name, ...(rest ? numberWords(rest) : [])];
    }
  }
  return [];
}

/**
 * How a voice reads a digit token: years in pairs ("nineteen ninety"), decimals digit by digit,
 * ordinals ("21st"), long digit strings one by one.
 * @param {string} tok @returns {string[]}
 */
export function expandNumber(tok) {
  const t = tok.replace(/,/g, '');
  const ord = /^(\d+)(st|nd|rd|th)$/i.exec(t);
  if (ord) {
    const w = numberWords(Number(ord[1]));
    const last = w[w.length - 1];
    const ORD = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
    w[w.length - 1] = ORD[last] || (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`);
    return w;
  }
  const dec = /^(\d+)\.(\d+)$/.exec(t);
  if (dec) return [...expandNumber(dec[1]), 'point', ...dec[2].split('').map((d) => ONES[Number(d)])];
  if (!/^\d+$/.test(t)) return t.split('').filter((c) => /\d/.test(c)).map((d) => ONES[Number(d)]);
  if (t.length > 9 || (t.length > 1 && t[0] === '0')) return t.split('').map((d) => ONES[Number(d)]);
  const n = Number(t);
  if (t.length === 4 && n >= 1100 && n <= 2099 && n % 1000 >= 10 && !(n >= 2000 && n < 2010)) {
    const hi = Math.floor(n / 100), lo = n % 100;
    return [...numberWords(hi), ...(lo === 0 ? ['hundred'] : lo < 10 ? ['oh', ONES[lo]] : numberWords(lo))];
  }
  return numberWords(n);
}

// ---------------------------------------------------------------------------------------------
// Words → phones
// ---------------------------------------------------------------------------------------------
/** Pronounce one word (no spaces). @param {string} raw @returns {Phone[]} */
export function wordToPhones(raw) {
  const word = String(raw || '').toLowerCase().replace(/[’‘`´]/g, "'").replace(/^'+|'+$/g, '');
  if (!word) return [];
  const hit = DICTIONARY.get(word);
  if (hit) return hit.map((p) => ({ ...p }));
  if (/\d/.test(word)) {
    const out = [];
    for (const w of expandNumber(word)) out.push(...wordToPhones(w));
    return out;
  }
  // possessive / contraction endings on unknown words: "Claude's", "Python's"
  const poss = /^(.+)'(s|d|ll|re|ve)$/.exec(word);
  if (poss) {
    const base = wordToPhones(poss[1]);
    const last = base[base.length - 1]?.ph;
    const tail = poss[2] === 's'
      ? (['S', 'Z', 'SH', 'ZH', 'CH', 'JH'].includes(last) ? 'IH0 Z' : ['P', 'T', 'K', 'F', 'TH'].includes(last) ? 'S' : 'Z')
      : { d: 'D', ll: 'L', re: 'ER0', ve: 'V' }[poss[2]];
    return [...base, ...parsePhones(tail)];
  }
  const phs = letterToSound(word);
  if (!phs.length) return [];
  // the rules sometimes emit two identical phonemes at a letter boundary ("SS" etc.): merge
  const dedup = phs.filter((p, i) => i === 0 || p !== phs[i - 1] || VOWEL_SET.has(p));
  return assignStress(word, dedup);
}

/**
 * Capitalised technical terms and names that are read as words, not shouted: in a coding
 * assistant's replies they are not emphasis.
 */
const CAPS_TERMS = new Set(('README TODO FIXME NOTE JSON YAML TOML REST CRUD CORS AJAX ASCII UNICODE UUID GUID JPEG MIME '
  + 'OAUTH PATH HOME NODE NULL TRUE FALSE NASA LINUX UNIX WASM SELECT FROM WHERE INSERT UPDATE DELETE').split(' '));

/** A token is an acronym the voice spells: all capitals, 2-5 letters, or no vowel at all. */
function isAcronym(tok) {
  if (!/^[A-Z]{2,5}s?$/.test(tok)) return false;
  const core = tok.replace(/s$/, '');
  if (DICTIONARY.has(core.toLowerCase()) && core.length > 2) return false; // "OK", "THE" shouted…
  return !/[AEIOUY]/.test(core) || core.length <= 3;
}

const PUNCT_RE = /[,;:.!?…—–]/;
/** What may follow punctuation that the voice pauses at: a space, a closing quote or bracket. */
const PUNCT_FOLLOW_RE = /[\s"'”’»)\]}*_]/;

/**
 * Split text into pronounced words with their character offsets and following punctuation.
 * Hyphenated and slashed words are separate words (voices send a boundary for each part).
 * @param {string} text @returns {WordPron[]}
 */
export function textToWords(text) {
  const s = String(text || '');
  const letters = s.replace(/[^A-Za-z]/g, '');
  const shouting = letters.length > 0 && letters === letters.toUpperCase();
  /** @type {WordPron[]} */
  const words = [];
  const re = /(\d[\d,]*(?:\.\d+)?(?:st|nd|rd|th)?%?)|([A-Za-zÀ-ɏ]+(?:['’][A-Za-z]+)*)|([,;:.!?…—–]+)|([\p{L}\p{M}]+)/gu;
  let m;
  while ((m = re.exec(s))) {
    if (m[3]) {
      // a mark inside a token ("github.com", "package.json", "Node.js", "10:30", "v2.1.3") is
      // read straight through: no pause, no phrase end. Dashes pause even without spaces.
      const next = s[m.index + m[3].length];
      if (next !== undefined && !PUNCT_FOLLOW_RE.test(next) && !/[—–]/.test(m[3])) continue;
      const prev = words[words.length - 1];
      if (prev && !prev.punct) prev.punct = normalizePunct(m[3]);
      continue;
    }
    const tok = m[0];
    const prevWord = words[words.length - 1];
    if (prevWord && prevWord.end === m.index - 1 && s[m.index - 1] === '.' && /[A-Za-z]/.test(s[m.index - 2] || '') && /^[A-Za-z]{2}/.test(tok)) {
      // "package.json", "github.com": the voice says "dot" (not "e.g.", "a.m.", "U.S.")
      words.push({ text: 'dot', start: m.index - 1, end: m.index, phones: wordToPhones('dot'), punct: '', content: false, emphasis: false });
    }
    let phones;
    if (m[1]) {
      const pct = tok.endsWith('%');
      phones = wordToPhones(pct ? tok.slice(0, -1) : tok);
      if (pct) phones.push(...wordToPhones('percent'));
    } else if (m[4]) {
      phones = genericPhones(tok);       // another script: a plausible open/close per syllable
    } else if (isAcronym(tok)) {
      phones = spell(tok.replace(/s$/, ''));
      if (tok.endsWith('s')) phones.push({ ph: 'Z', stress: 0 });
    } else {
      phones = wordToPhones(tok.normalize('NFD').replace(/[̀-ͯ]/g, ''));
    }
    if (!phones.length) continue;
    const lower = tok.toLowerCase().replace(/’/g, "'");
    // a shouted word ("REALLY") in normal text is emphasis (an all-caps text is not); technical
    // capitals ("JSON", "README") and parts of names ("CLAUDE.md", "NODE_ENV") are not
    const identifier = /^(\.[A-Za-z]|_)/.test(s.slice(m.index + tok.length)) || s[m.index - 1] === '_';
    const caps = /^[A-Z]{3,}$/.test(tok) && !isAcronym(tok) && !shouting && !CAPS_TERMS.has(tok) && !identifier;
    words.push({
      text: tok, start: m.index, end: m.index + tok.length, phones, punct: '',
      content: !FUNCTION_WORDS.has(lower) && !/^\d/.test(tok),
      emphasis: caps || EMPHATIC.has(lower),
    });
  }
  return words;
}

const SYLLABIC_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const GENERIC_C = ['D', 'N', 'K', 'L', 'M', 'S', 'T', 'R'];
const GENERIC_V = ['AA', 'EH', 'IH', 'OW', 'AE', 'UW'];

/**
 * Words of scripts these rules do not cover (Cyrillic, Greek, CJK…): one consonant-vowel pair
 * per estimated syllable (a character each in CJK / kana / hangul, ~2.4 letters elsewhere),
 * chosen from the characters so the same word always looks the same. Better than a still mouth.
 * @param {string} tok @returns {Phone[]}
 */
export function genericPhones(tok) {
  const chars = [...String(tok)].filter((c) => /\p{L}/u.test(c));
  if (!chars.length) return [];
  const n = chars.some((c) => SYLLABIC_SCRIPT.test(c)) ? chars.length : Math.max(1, Math.round(chars.length / 2.4));
  const out = [];
  for (let i = 0; i < n; i++) {
    const code = chars[i % chars.length].codePointAt(0) || 0;
    out.push({ ph: GENERIC_C[code % GENERIC_C.length], stress: 0 });
    out.push({ ph: GENERIC_V[(code >> 3) % GENERIC_V.length], stress: i === 0 ? 1 : 0 });
  }
  return out;
}

/** @param {string} p */
function normalizePunct(p) {
  if (p.includes('?')) return '?';
  if (p.includes('!')) return '!';
  if (p.includes('.') || p.includes('…')) return '.';
  if (p.includes(';') || p.includes(':')) return ';';
  if (p.includes('—') || p.includes('–')) return '—';
  return PUNCT_RE.test(p) ? ',' : '';
}

/** @param {string} ph */
export function isVowel(ph) {
  return VOWEL_SET.has(ph);
}
