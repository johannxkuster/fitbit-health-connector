// Тесты чистых помощников клиента Google Health API.
// Запуск: npm test (сначала esbuild собирает src → dist-test).
import test from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  apiCall,
  chunkCivilRange,
  dailyRollUpBody,
  healthErrorCode,
  rollupDate,
  rollupRangeCapDays,
  toApiDate,
  toSessionInterval,
} from "../dist-test/health-api.mjs";

test('Health uses a narrowed token and rejects an unexpectedly broad token', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const env={ALLOWED_GOOGLE_EMAIL:'owner@example.test',GOOGLE_CLIENT_ID:'test',GOOGLE_CLIENT_SECRET:'test'};
  const props={authVersion:2,sub:'owner',email:'owner@example.test',refreshToken:'test',accessToken:'broad',accessTokenExpiresAt:Date.now()+3600000};
  globalThis.fetch=async (url,init) => {
    if (String(url).includes('oauth2.googleapis.com')) {
      const scope=new URLSearchParams(init.body).get('scope');
      assert.ok(scope.split(' ').every(s=>s.startsWith('https://www.googleapis.com/auth/googlehealth.')));
      return Response.json({access_token:'narrow',scope:scope+' https://www.googleapis.com/auth/spreadsheets'});
    }
    throw new Error('Health must not receive the broad token');
  };
  await assert.rejects(()=>apiCall(env,props,'/test'),/GOOGLE_SCOPED_TOKEN_REQUIRED/);
});

test('Google error diagnostics expose only known fixed codes', () => {
  assert.equal(healthErrorCode(403, {error:{details:[{reason:'MISSING_OAUTH_SCOPE', metadata:{token:'secret'}}]}}), 'HEALTH_HTTP_403_MISSING_OAUTH_SCOPE');
  assert.equal(healthErrorCode(403, {error:{details:[{reason:'secret'}],message:'secret'}}), 'HEALTH_HTTP_403');
  assert.equal(healthErrorCode(403, {error:{message:'Could not mint UberMint from GaiaMint.'}}), 'HEALTH_HTTP_403_LEGACY_ACCOUNT');
  assert.equal(healthErrorCode(503, null), 'HEALTH_HTTP_503');
});

test("dailyRollUpBody: не содержит pageSize — живой API принимает pageSize×windowSizeDays за длительность запроса", () => {
  const body = dailyRollUpBody("2026-08-05", "2026-08-07");
  assert.ok(!("pageSize" in body), "pageSize в теле dailyRollUp ломает запрос (INVALID_ROLLUP_QUERY_DURATION)");
  assert.equal(body.windowSizeDays, 1, "windowSizeDays обязателен для живого API");
  assert.deepEqual(body.range, {
    start: { date: { year: 2026, month: 8, day: 5 } },
    end: { date: { year: 2026, month: 8, day: 7 } },
  });
  assert.ok(!("dataSourceFamily" in body));
});

test("dailyRollUpBody: dataSourceFamily разворачивается в полный resource name", () => {
  const body = dailyRollUpBody("2026-08-05", "2026-08-06", "google-wearables");
  assert.equal(body.dataSourceFamily, "users/me/dataSourceFamilies/google-wearables");
});

test("rollupRangeCapDays: 14 дней для короткого набора, 90 для остальных", () => {
  for (const t of ["heart-rate", "total-calories", "active-minutes", "calories-in-heart-rate-zone"]) {
    assert.equal(rollupRangeCapDays(t), 14, t);
  }
  for (const t of ["steps", "distance", "floors", "active-zone-minutes", "active-energy-burned"]) {
    assert.equal(rollupRangeCapDays(t), 90, t);
  }
});

test("chunkCivilRange: период короче лимита — один кусок как есть", () => {
  assert.deepEqual(chunkCivilRange("2026-08-05", "2026-08-07", 90), [
    { start: "2026-08-05", endExclusive: "2026-08-07" },
  ]);
});

test("chunkCivilRange: ровно лимит — один кусок", () => {
  assert.deepEqual(chunkCivilRange("2026-08-01", "2026-08-15", 14), [
    { start: "2026-08-01", endExclusive: "2026-08-15" },
  ]);
});

test("chunkCivilRange: длинный период режется на смежные куски без дыр", () => {
  const chunks = chunkCivilRange("2026-07-18", "2026-08-07", 14); // 20 дней
  assert.deepEqual(chunks, [
    { start: "2026-07-18", endExclusive: "2026-08-01" },
    { start: "2026-08-01", endExclusive: "2026-08-07" },
  ]);
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i].start, chunks[i - 1].endExclusive, "куски должны стыковаться");
  }
});

test("chunkCivilRange: пустой диапазон — ноль кусков", () => {
  assert.deepEqual(chunkCivilRange("2026-08-05", "2026-08-05", 90), []);
});

test("addDays: перенос через границу месяца и года", () => {
  assert.equal(addDays("2026-08-31", 1), "2026-09-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("toApiDate: разбирает YYYY-MM-DD в числовые поля", () => {
  assert.deepEqual(toApiDate("2026-08-05"), { year: 2026, month: 8, day: 5 });
});

test("toSessionInterval: моментальный лог получает интервал в 1 минуту", () => {
  const iv = toSessionInterval("2026-08-06T17:45:00+03:00");
  assert.equal(iv.startTime, "2026-08-06T14:45:00Z");
  assert.equal(iv.endTime, "2026-08-06T14:46:00Z");
  assert.equal(iv.startUtcOffset, "10800s");
});

test("toSessionInterval: явный конец позже начала не трогаем", () => {
  const iv = toSessionInterval("2026-08-06T10:00:00Z", "2026-08-06T11:30:00Z");
  assert.equal(iv.endTime, "2026-08-06T11:30:00Z");
});

test("rollupDate: достаёт YYYY-MM-DD из civilStartTime точки роллапа", () => {
  assert.equal(
    rollupDate({ civilStartTime: { date: { year: 2026, month: 8, day: 5 } } }),
    "2026-08-05",
  );
  assert.equal(rollupDate({}), undefined);
});

