/* GMS jobs with the stats MapleScouter's stat table asks for.
 * main: the stat(s) whose pop-out goes in step 1; sub: the secondary stat(s) for step 2.
 * att: which attack the class scales with ("magic" for magicians, "attack" for everyone else).
 * Edit this file if a class is missing or changes. */
(function (root) {
  'use strict';
  const W = (name) => ({ name, group: 'Warrior', main: ['str'], sub: ['dex'], att: 'attack' });
  const M = (name) => ({ name, group: 'Magician', main: ['int'], sub: ['luk'], att: 'magic' });
  const A = (name) => ({ name, group: 'Bowman', main: ['dex'], sub: ['str'], att: 'attack' });
  const T = (name) => ({ name, group: 'Thief', main: ['luk'], sub: ['dex'], att: 'attack' });
  const T2 = (name) => ({ name, group: 'Thief', main: ['luk'], sub: ['dex', 'str'], att: 'attack' });
  const PS = (name) => ({ name, group: 'Pirate', main: ['str'], sub: ['dex'], att: 'attack' });
  const PD = (name) => ({ name, group: 'Pirate', main: ['dex'], sub: ['str'], att: 'attack' });

  const CLASSES = [
    W('Hero'), W('Paladin'), W('Dark Knight'), W('Dawn Warrior'), W('Mihile'), W('Aran'), W('Blaster'),
    W('Kaiser'), W('Adele'), W('Zero'), W('Hayato'), W('Ren'), W('Demon Slayer'),
    { name: 'Demon Avenger', group: 'Warrior', main: ['hp'], sub: ['str'], att: 'attack' },
    M('Arch Mage (Fire, Poison)'), M('Arch Mage (Ice, Lightning)'), M('Bishop'), M('Blaze Wizard'), M('Evan'),
    M('Luminous'), M('Battle Mage'), M('Kanna'), M('Illium'), M('Lara'), M('Kinesis'), M('Beast Tamer'),
    M('Lynn'), M('Sia Astelle'),
    A('Bowmaster'), A('Marksman'), A('Pathfinder'), A('Wind Archer'), A('Wild Hunter'), A('Mercedes'), A('Kain'),
    T('Night Lord'), T('Night Walker'), T('Phantom'), T('Khali'), T('Hoyoung'),
    T2('Shadower'), T2('Dual Blade'), T2('Cadena'),
    { name: 'Xenon', group: 'Thief / Pirate', main: ['str', 'dex', 'luk'], sub: [], att: 'attack' },
    PS('Buccaneer'), PD('Corsair'), PS('Cannoneer'), PS('Thunder Breaker'), PS('Shade'), PD('Mechanic'),
    PD('Angelic Buster'), PS('Ark'), PD('Mo Xuan')
  ];

  const STAT_NAMES = { str: 'STR', dex: 'DEX', int: 'INT', luk: 'LUK', hp: 'HP', attack: 'ATTACK POWER', magic: 'MAGIC ATT' };

  const exp = { CLASSES, STAT_NAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = exp; else root.MSClasses = exp;
})(typeof self !== 'undefined' ? self : this);
