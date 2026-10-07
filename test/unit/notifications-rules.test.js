import { describe, expect, it } from 'vitest';
import { buildMessages } from '../../src/infra/fcm.js';
import {
  eatingWindowNotifications,
  fastNotifications,
  quietUntil,
  render,
  waterSlots,
} from '../../src/modules/notifications/notifications.rules.js';

const TZ = 'Europe/Istanbul'; // UTC+3
const H = 3_600_000;

describe('sessiz saatler (10 §4.1)', () => {
  it('gece yarısını aşan aralık: içindeyse bitiş anı, değilse null', () => {
    // 23:30 İstanbul = 20:30Z
    expect(quietUntil(new Date('2026-10-07T20:30:00Z'), TZ, '22:30', '08:00')).toEqual(
      new Date('2026-10-08T05:00:00Z'),
    );
    // 07:00 İstanbul → aynı sabah 08:00
    expect(quietUntil(new Date('2026-10-08T04:00:00Z'), TZ, '22:30', '08:00')).toEqual(
      new Date('2026-10-08T05:00:00Z'),
    );
    expect(quietUntil(new Date('2026-10-08T09:00:00Z'), TZ, '22:30', '08:00')).toBeNull();
    // Gün içi aralık ve kapalı (başlangıç = bitiş)
    expect(quietUntil(new Date('2026-10-08T11:00:00Z'), TZ, '13:00', '15:00')).toEqual(
      new Date('2026-10-08T12:00:00Z'),
    );
    expect(quietUntil(new Date('2026-10-08T11:00:00Z'), TZ, '00:00', '00:00')).toBeNull();
  });
});

describe('şablon', () => {
  it('yer tutucular; sayılar dile göre; bilinmeyen kalır', () => {
    expect(render('Yeni kilon: {weightKg} kg', { weightKg: 72.4 }, 'tr')).toBe(
      'Yeni kilon: 72,4 kg',
    );
    expect(render('New weight {weightKg} kg', { weightKg: 72.4 }, 'en')).toBe('New weight 72.4 kg');
    expect(render('{streak}-day streak, {name}', { streak: 7 }, 'en')).toBe('7-day streak, {name}');
  });
});

describe('planlanan bildirimler', () => {
  it('su saatleri: uyanış+1 sa – yatış−1 sa, aralıkla', () => {
    expect(waterSlots('07:00', '23:00', 120)).toEqual([
      '08:00',
      '10:00',
      '12:00',
      '14:00',
      '16:00',
      '18:00',
      '20:00',
      '22:00',
    ]);
    expect(waterSlots('06:30', '22:00', 240)).toEqual(['07:30', '11:30', '15:30', '19:30']);
  });

  it('oruç: hedef, yarı yol (≥14 sa), en derin evre (günde 1), unutulan oruç', () => {
    const startedAt = new Date('2026-10-07T17:00:00Z');
    const n = fastNotifications({
      id: 'f1',
      startedAt,
      targetMinutes: 18 * 60,
      plannedEndAt: new Date(startedAt.getTime() + 18 * H),
    });
    expect(n.map((x) => [x.type, (x.fireAt - startedAt) / H])).toEqual([
      ['fast_goal_reached', 18],
      ['fast_halfway', 9],
      ['fast_stage_reached', 16],
      ['fast_overdue', 30],
    ]);
    expect(n.every((x) => x.dedupeKey.startsWith('fast:f1:'))).toBe(true);

    // 16 sa planı: 16 sa evresi hedefle aynı an → 12 sa evresi; 12 sa planında yarı yol yok
    const sixteen = fastNotifications({
      id: 'f2',
      startedAt,
      targetMinutes: 960,
      plannedEndAt: new Date(startedAt.getTime() + 16 * H),
    });
    expect(sixteen.find((x) => x.type === 'fast_stage_reached').fireAt).toEqual(
      new Date(startedAt.getTime() + 12 * H),
    );
    const twelve = fastNotifications({
      id: 'f3',
      startedAt,
      targetMinutes: 720,
      plannedEndAt: new Date(startedAt.getTime() + 12 * H),
    });
    expect(twelve.map((x) => x.type)).toEqual(['fast_goal_reached', 'fast_overdue']);
  });

  it('yeme penceresi: bitişten 30 dk önce ve bitişte', () => {
    const endedAt = new Date('2026-10-07T09:00:00Z');
    const n = eatingWindowNotifications({ id: 'f1', endedAt, eatMinutes: 480 });
    expect(n.map((x) => [x.type, (x.fireAt - endedAt) / 60_000])).toEqual([
      ['eating_window_ending', 450],
      ['meal_window_ended', 480],
    ]);
    expect(eatingWindowNotifications({ id: 'f1', endedAt, eatMinutes: 30 })).toEqual([]);
  });
});

describe('FCM mesajı', () => {
  it('sessiz gönderimde ses yok (iOS passive, Android düşük öncelik); veri string', () => {
    const [loud] = buildMessages(['t1'], { title: 'a', body: 'b', data: { n: 1, x: null } });
    expect(loud).toMatchObject({
      token: 't1',
      notification: { title: 'a', body: 'b' },
      data: { n: '1' },
      apns: { payload: { aps: { sound: 'default' } } },
      android: { priority: 'high' },
    });
    const [quiet] = buildMessages(['t1'], { title: 'a', body: 'b', silent: true });
    expect(quiet.apns.payload.aps).toEqual({ 'interruption-level': 'passive' });
    expect(quiet.android).toMatchObject({
      priority: 'normal',
      notification: { channelId: 'quiet' },
    });
  });
});
