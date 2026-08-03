/**
 * LE CALENDRIER FAMILIAL — extension hors spec v1.0, assumée.
 *
 * Le Trigger Model calcule de vraies occasions datées, et les affiche dans
 * une page que personne n'a ouverte. Le signal est juste ; il ne rencontre
 * personne. Une mémoire familiale en « pull » intégral s'ouvre à Noël, puis
 * plus jamais.
 *
 * ── Pourquoi ce n'est pas une notification ──
 *
 * La Constitution interdit la pression et l'urgence fabriquée. Elle
 * n'interdit pas qu'une date existe. La ligne, et elle est nette :
 *
 *   UNE DATE NE SORT DE L'APPLICATION QUE SI ELLE EXISTE SANS ELLE.
 *
 * Une série de connexions est fabriquée par le produit : sans le produit,
 * elle n'existe pas. Le 8 novembre 2014, jour de la mort de Robert, existe
 * que cette application existe ou non. Le test : un humain qui ne
 * connaîtrait que le calendrier déclaré de la famille aurait-il pu écrire
 * cette ligne ?
 *
 * Conséquence directe, et c'est une exclusion : `Story.createdAt` n'entre
 * PAS dans ce calendrier. « Il y a trois ans, ce récit a été raconté » est
 * une occasion que le produit s'est fabriquée à lui-même. `Story.eventDate`,
 * lui, désigne un fait du monde — il entre.
 *
 * ── Pourquoi une récurrence, et pas des occurrences calculées ──
 *
 * Un agenda met le flux en cache. Une ligne « il y a 10 ans » gravée
 * aujourd'hui sera fausse l'an prochain, sans que personne ne s'en rende
 * compte : c'est exactement le défaut que ce produit passe son temps à
 * corriger — affirmer un calcul qui vieillit. On publie donc une règle
 * annuelle et l'année de référence ; l'arithmétique reste au lecteur.
 *
 * ── Ce qu'il faut dire à la famille ──
 *
 * Ce flux vit dans Google ou Apple. Les noms et les titres y sortent. On
 * n'y met donc jamais le texte d'un récit, et l'interface le dit en toutes
 * lettres avant de donner le lien.
 */

export interface CalendarEvent {
  /** Stable dans le temps : le même événement doit garder le même UID. */
  uid: string;
  /** Premier jour de la série. La récurrence est annuelle. */
  start: Date;
  summary: string;
  description: string;
}

export interface CalendarSource {
  familyName: string;
  members: Array<{ id: string; name: string; birthDate: Date | null; deathDate: Date | null }>;
  traditions: Array<{ id: string; name: string; description: string; monthDay: string | null }>;
  stories: Array<{ id: string; title: string; eventDate: Date | null }>;
}

/**
 * Les occasions de la famille, dans l'ordre où elles tombent dans l'année.
 * Aucune n'est déduite : chacune vient d'une date saisie par quelqu'un.
 */
export function familyEvents(source: CalendarSource, year: number): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  for (const member of source.members) {
    // Un vivant a un anniversaire ; un défunt n'en a plus. Continuer à
    // fêter la naissance de quelqu'un qui est mort, sans le dire, serait
    // le genre de maladresse qu'un produit commet et qu'un proche jamais.
    if (member.birthDate && !member.deathDate) {
      events.push({
        uid: `naissance-${member.id}`,
        start: member.birthDate,
        summary: `Anniversaire de ${member.name}`,
        // Pas d'accord en genre : l'application n'enregistre pas le genre
        // de ses membres et n'a pas à le deviner d'après un prénom.
        description: `Date de naissance enregistrée : ${isoDay(member.birthDate)}.`,
      });
    }

    if (member.deathDate) {
      const born = member.birthDate ? `${member.birthDate.getFullYear()}–` : '';
      events.push({
        uid: `deces-${member.id}`,
        start: member.deathDate,
        summary: `${member.name} (${born}${member.deathDate.getFullYear()})`,
        description: `Date de décès enregistrée : ${isoDay(member.deathDate)}.`,
      });
    }
  }

  for (const tradition of source.traditions) {
    const start = monthDayToDate(tradition.monthDay, year);
    if (!start) continue;
    events.push({
      uid: `tradition-${tradition.id}`,
      start,
      summary: `Tradition : ${tradition.name}`,
      description: tradition.description,
    });
  }

  for (const story of source.stories) {
    if (!story.eventDate) continue;
    events.push({
      uid: `evenement-${story.id}`,
      start: story.eventDate,
      summary: `${story.title} (${story.eventDate.getFullYear()})`,
      description: `Date de l'événement raconté dans ce récit.`,
    });
  }

  return events.sort((a, b) => monthDayKey(a.start) - monthDayKey(b.start) || a.uid.localeCompare(b.uid));
}

/**
 * Le flux iCalendar (RFC 5545).
 *
 * `stamp` est passé en argument plutôt que lu de l'horloge : deux
 * téléchargements du même calendrier inchangé doivent rendre le même
 * octet, sinon chaque agenda croit à une modification.
 */
export function toIcs(
  events: CalendarEvent[],
  options: { calendarName: string; stamp: Date },
): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Heritage//Memoire familiale//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(options.calendarName)}`,
    // Une fois par jour suffit : ces dates ne changent pas à la minute.
    'REFRESH-INTERVAL;VALUE=DURATION:P1D',
    'X-PUBLISHED-TTL:P1D',
  ];

  for (const event of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.uid}@heritage`,
      `DTSTAMP:${utcStamp(options.stamp)}`,
      // Journée entière : ni heure, ni fuseau, donc rien à décaler d'un
      // pays à l'autre. Un anniversaire n'a pas d'heure.
      `DTSTART;VALUE=DATE:${icsDate(event.start)}`,
      // Le 29 février ne tombe que les années bissextiles : la RFC saute
      // les dates qui n'existent pas. C'est le comportement juste — la
      // date est la date, on ne la déplace pas d'office au 1er mars.
      'RRULE:FREQ=YEARLY',
      // Ces journées ne rendent personne occupé.
      'TRANSP:TRANSPARENT',
      `SUMMARY:${escapeText(event.summary)}`,
      `DESCRIPTION:${escapeText(event.description)}`,
      // Aucun VALARM : l'application ne décide pas d'interrompre
      // quelqu'un. Qui veut un rappel le règle dans son agenda.
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** RFC 5545 §3.1 : 75 octets par ligne, la suite préfixée d'une espace. */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const chunks: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    // On ne coupe jamais au milieu d'un caractère multi-octets : « é »
    // scindé en deux lignes devient deux octets illisibles.
    let end = Math.min(start + (chunks.length === 0 ? 75 : 74), bytes.length);
    while (end > start && end < bytes.length && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
    chunks.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return chunks.join('\r\n ');
}

/** RFC 5545 §3.3.11 : la virgule, le point-virgule et la barre s'échappent. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsDate(date: Date): string {
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`;
}

function utcStamp(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

function isoDay(date: Date): string {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

function monthDayKey(date: Date): number {
  return (date.getMonth() + 1) * 100 + date.getDate();
}

/** « 10-15 » → le 15 octobre de l'année demandée. */
function monthDayToDate(monthDay: string | null, year: number): Date | null {
  if (!monthDay) return null;
  const match = monthDay.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(year, month - 1, day);
  // Le 31 février saisi à la main deviendrait le 3 mars : on refuse.
  return date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}
