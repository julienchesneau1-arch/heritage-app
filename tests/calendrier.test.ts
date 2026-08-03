import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { familyEvents, toIcs, type CalendarSource } from '@/lib/calendar';
import { FamilyService } from '@/services/family.service';
import { constitutionEmotionFilter, isNonCoerciveLanguage } from '@/lib/constitution';

const STAMP = new Date(Date.UTC(2026, 7, 3));

const SOURCE: CalendarSource = {
  familyName: 'Martin',
  members: [
    { id: 'm_jeanne', name: 'Jeanne Martin', birthDate: new Date(1934, 5, 21), deathDate: null },
    {
      id: 'm_robert',
      name: 'Robert Martin',
      birthDate: new Date(1931, 2, 12),
      deathDate: new Date(2014, 10, 8),
    },
  ],
  traditions: [
    {
      id: 't_tarte',
      name: 'La tarte aux poires',
      description: 'On la fait le 15 octobre, avec les poires du jardin.',
      monthDay: '10-15',
    },
  ],
  stories: [
    { id: 's_demenagement', title: 'Le déménagement de Bordeaux', eventDate: new Date(1971, 10, 3) },
    { id: 's_sans_date', title: 'La montre arrêtée', eventDate: null },
  ],
};

describe('Le calendrier ne publie que des dates qui existent sans l’application', () => {
  it('publie les naissances, les décès, les traditions et les événements racontés', () => {
    const uids = familyEvents(SOURCE, 2026).map((event) => event.uid);
    expect(uids).toContain('naissance-m_jeanne');
    expect(uids).toContain('deces-m_robert');
    expect(uids).toContain('tradition-t_tarte');
    expect(uids).toContain('evenement-s_demenagement');
  });

  it('ne publie jamais la date de création d’un récit', () => {
    // « Il y a trois ans, ce récit a été raconté » est une occasion que le
    // produit se fabrique à lui-même. C'est la ligne à ne pas franchir.
    const source: CalendarSource = { ...SOURCE, stories: [{ id: 's_x', title: 'X', eventDate: null }] };
    expect(familyEvents(source, 2026)).toHaveLength(3); // naissance, décès, tradition
  });

  it('ignore un récit sans date d’événement', () => {
    const uids = familyEvents(SOURCE, 2026).map((event) => event.uid);
    expect(uids).not.toContain('evenement-s_sans_date');
  });

  it('ne souhaite pas l’anniversaire de quelqu’un qui est mort', () => {
    const uids = familyEvents(SOURCE, 2026).map((event) => event.uid);
    expect(uids).toContain('deces-m_robert');
    expect(uids).not.toContain('naissance-m_robert');
  });

  it('range les occasions dans l’ordre de l’année', () => {
    const events = familyEvents(SOURCE, 2026);
    const months = events.map((event) => event.start.getMonth());
    expect(months).toEqual([...months].sort((a, b) => a - b));
  });
});

describe('Le calendrier n’affirme aucun calcul qui vieillira', () => {
  it('n’écrit jamais « il y a N ans » dans un flux que l’agenda met en cache', () => {
    const ics = toIcs(familyEvents(SOURCE, 2026), { calendarName: 'Martin', stamp: STAMP });
    expect(ics).not.toMatch(/il y a \d+ an/i);
  });

  it('donne l’année de référence et laisse l’arithmétique au lecteur', () => {
    const deces = familyEvents(SOURCE, 2026).find((event) => event.uid === 'deces-m_robert')!;
    expect(deces.summary).toContain('1931');
    expect(deces.summary).toContain('2014');
  });

  it('publie une règle annuelle plutôt que des occurrences figées', () => {
    const ics = toIcs(familyEvents(SOURCE, 2026), { calendarName: 'Martin', stamp: STAMP });
    expect(ics).toContain('RRULE:FREQ=YEARLY');
  });

  it('rend deux fois le même octet pour une famille inchangée', () => {
    // Sans cela, chaque agenda de la famille croit à une modification à
    // chaque rafraîchissement.
    const first = toIcs(familyEvents(SOURCE, 2026), { calendarName: 'Martin', stamp: STAMP });
    const second = toIcs(familyEvents(SOURCE, 2026), { calendarName: 'Martin', stamp: STAMP });
    expect(first).toBe(second);
  });
});

describe('Le calendrier respecte la Constitution', () => {
  it('n’infère aucune émotion et n’exerce aucune pression', () => {
    for (const event of familyEvents(SOURCE, 2026)) {
      expect(constitutionEmotionFilter(event.summary)).toBe(true);
      expect(isNonCoerciveLanguage(event.summary)).toBe(true);
      expect(constitutionEmotionFilter(event.description)).toBe(true);
      expect(isNonCoerciveLanguage(event.description)).toBe(true);
    }
  });

  it('ne pose aucune alarme : l’application ne décide pas d’interrompre', () => {
    const ics = toIcs(familyEvents(SOURCE, 2026), { calendarName: 'Martin', stamp: STAMP });
    expect(ics).not.toContain('VALARM');
  });

  it('ne marque personne comme occupé', () => {
    const ics = toIcs(familyEvents(SOURCE, 2026), { calendarName: 'Martin', stamp: STAMP });
    expect(ics).toContain('TRANSP:TRANSPARENT');
  });

  it('ne fait sortir aucun texte de récit de l’application', () => {
    const source: CalendarSource = {
      ...SOURCE,
      stories: [{ id: 's1', title: 'Le déménagement de Bordeaux', eventDate: new Date(1971, 10, 3) }],
    };
    const ics = toIcs(familyEvents(source, 2026), { calendarName: 'Martin', stamp: STAMP });
    // Le titre sort — il est dans le sommaire, c'est le but. Le contenu, jamais.
    expect(ics).toContain('Le déménagement de Bordeaux');
    expect(ics.length).toBeLessThan(4000);
  });
});

describe('Le flux est un iCalendar valide (RFC 5545)', () => {
  const ics = toIcs(familyEvents(SOURCE, 2026), {
    calendarName: 'Famille Martin — mémoire',
    stamp: STAMP,
  });

  it('ouvre et ferme le calendrier', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('sépare ses lignes par CRLF', () => {
    expect(ics.split('\r\n').length).toBeGreaterThan(10);
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('équilibre les VEVENT', () => {
    const open = ics.match(/BEGIN:VEVENT/g) ?? [];
    const close = ics.match(/END:VEVENT/g) ?? [];
    expect(open.length).toBe(close.length);
    expect(open.length).toBe(familyEvents(SOURCE, 2026).length);
  });

  it('écrit des journées entières, sans heure ni fuseau', () => {
    expect(ics).toContain('DTSTART;VALUE=DATE:19341121'.slice(0, 20));
    expect(ics).not.toContain('DTSTART:');
  });

  it('échappe la virgule et le point-virgule des textes libres', () => {
    const source: CalendarSource = {
      ...SOURCE,
      traditions: [
        { id: 't', name: 'Poires, pommes; coings', description: 'Un, deux; trois', monthDay: '10-15' },
      ],
    };
    const escaped = toIcs(familyEvents(source, 2026), { calendarName: 'M', stamp: STAMP });
    expect(escaped).toContain('Poires\\, pommes\\; coings');
  });

  it('replie les lignes de plus de 75 octets sans casser un accent', () => {
    const source: CalendarSource = {
      ...SOURCE,
      traditions: [
        {
          id: 't_long',
          name: 'é'.repeat(120),
          description: 'Une description très longue '.repeat(6),
          monthDay: '10-15',
        },
      ],
    };
    const long = toIcs(familyEvents(source, 2026), { calendarName: 'M', stamp: STAMP });

    for (const line of long.split('\r\n')) {
      expect(Buffer.from(line, 'utf8').length).toBeLessThanOrEqual(75);
    }
    // Aucun caractère de remplacement : les accents ont survécu au repli.
    expect(long).not.toContain('�');
    // Et le nom se reconstitue une fois les replis retirés.
    expect(long.replace(/\r\n /g, '')).toContain('é'.repeat(120));
  });

  it('donne à chaque événement un identifiant stable', () => {
    const premier = familyEvents(SOURCE, 2026).map((event) => event.uid);
    const suivant = familyEvents(SOURCE, 2030).map((event) => event.uid);
    // D'une année sur l'autre, ce sont les mêmes événements : un agenda ne
    // doit pas se retrouver avec deux fois la mort de Robert.
    expect(suivant).toEqual(premier);
  });

  it('refuse une date de tradition impossible plutôt que de la déplacer', () => {
    const source: CalendarSource = {
      ...SOURCE,
      traditions: [{ id: 't', name: 'Impossible', description: '', monthDay: '02-31' }],
    };
    expect(familyEvents(source, 2026).some((event) => event.uid === 'tradition-t')).toBe(false);
  });
});

describe('Le calendrier se révoque avec le lien personnel', () => {
  /**
   * Deux mécanismes de révocation seraient deux occasions d'en oublier un.
   * Le flux porte donc le jeton personnel lui-même : « Révoquer ce lien »
   * coupe les deux, pour ce membre et pour lui seul.
   */
  function serviceFor(tokenVersion: number) {
    const prisma = {
      member: { findFirst: async () => ({ id: 'mem_1', tokenVersion }) },
    } as unknown as PrismaClient;
    return new FamilyService(prisma);
  }

  it('signe le calendrier avec le jeton du lien personnel', async () => {
    const service = serviceFor(1);
    const personnel = (await service.personalLink('fam_1', 'mem_1'))!;
    const calendrier = (await service.calendarLink('fam_1', 'mem_1'))!;

    const jeton = personnel.split('/').pop()!;
    expect(calendrier).toContain(jeton);
  });

  it('change d’adresse dès que le lien est révoqué', async () => {
    const avant = await serviceFor(1).calendarLink('fam_1', 'mem_1');
    const apres = await serviceFor(2).calendarLink('fam_1', 'mem_1');
    expect(apres).not.toBe(avant);
  });

  it('ne donne aucun calendrier à un membre retiré de la famille', async () => {
    const prisma = { member: { findFirst: async () => null } } as unknown as PrismaClient;
    expect(await new FamilyService(prisma).calendarLink('fam_1', 'mem_1')).toBeNull();
  });
});
