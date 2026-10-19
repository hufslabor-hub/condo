// 관리자용 스크립트 (본인 PC에서만 실행. serviceAccount.json 은 절대 GitHub에 올리지 마세요)
//   npm i firebase-admin
//   node admin.js import members.csv   # 조합원 명부 등록 (CSV: 이름,생년월일8자리)
//   node admin.js tally                # 투표 집계 → meta/result 저장 (12/8 이후 실행)
const admin = require('firebase-admin');
const fs = require('fs');
const crypto = require('crypto');

const SALT = 'change-me'; // index.html 의 SALT와 반드시 동일하게

admin.initializeApp({ credential: admin.credential.cert(require('./serviceAccount.json')) });
const db = admin.firestore();
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

async function importMembers(file) {
  const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  const seen = new Set();
  let added = 0, kept = 0, bad = 0;
  for (const line of lines) {
    const [rawName, rawBirth] = line.split(',').map(s => (s || '').trim());
    if (rawName === '이름') continue; // 헤더
    const name = rawName.normalize('NFC').replace(/\s+/g, '');
    const birth = (rawBirth || '').replace(/\D/g, '');
    if (!name || birth.length !== 8) { console.warn('형식 오류, 건너뜀:', line); bad++; continue; }
    const key = sha(`${SALT}|${name}|${birth}`);
    if (seen.has(key)) { console.warn('이름+생년월일 중복(동명이인?), 건너뜀:', line); bad++; continue; }
    seen.add(key);
    const ref = db.collection('members').doc(key);
    if ((await ref.get()).exists) { kept++; continue; } // 기존 authorId 유지
    await ref.set({ name: rawName, authorId: crypto.randomUUID() });
    added++;
  }
  console.log(`완료: 신규 ${added}, 기존 유지 ${kept}, 제외 ${bad}`);
}

async function tally() {
  const votes = await db.collection('votes').get();
  let agree = 0, disagree = 0;
  votes.forEach(d => (d.data().choice === 'agree' ? agree++ : disagree++));
  const memberCount = (await db.collection('members').count().get()).data().count;
  await db.doc('meta/result').set({
    agree, disagree, total: agree + disagree, memberCount,
    tallyAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log({ agree, disagree, total: agree + disagree, memberCount });
}

const [cmd, arg] = process.argv.slice(2);
(cmd === 'import' && arg ? importMembers(arg) : cmd === 'tally' ? tally() : Promise.reject(new Error('사용법: node admin.js import members.csv | tally')))
  .catch(e => { console.error(e.message); process.exit(1); });
