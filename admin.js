// 관리자용 스크립트 (본인 PC에서만 실행. serviceAccount.json 은 절대 GitHub에 올리지 마세요)
//   npm i firebase-admin
//   node admin.js import members.csv   # 조합원 명부 등록 (CSV: 이름,생년월일8자리)
//   node admin.js tally                # 응답을 다시 세어 meta/tally(실시간 현황) 바로잡기
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const fs = require('fs');
const crypto = require('crypto');

const SALT = 'change-me'; // index.html 의 SALT와 반드시 동일하게

initializeApp({ credential: cert(require('./serviceAccount.json')) });
const db = getFirestore();
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

async function importMembers(file) {
  const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  const seen = new Set();
  let added = 0, kept = 0, bad = 0;
  for (const line of lines) {
    const [rawName, rawBirth] = line.split(',').map(s => (s || '').trim());
    if (rawName === '이름') continue; // 헤더
    if (!rawName && !rawBirth) continue; // 엑셀이 남기는 빈 줄(",")은 조용히 건너뜀
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
  // 실제 응답(votes)을 다시 세어 화면에 보이는 실시간 현황(meta/tally)을 바로잡습니다.
  // 테스트 응답을 지운 뒤나 마감 후 최종 확인 때 실행하세요.
  const votes = await db.collection('votes').get();
  let agree = 0, disagree = 0;
  votes.forEach(d => (d.data().choice === 'agree' ? agree++ : disagree++));
  const memberCount = (await db.collection('members').count().get()).data().count;
  await db.doc('meta/tally').set({ agree, disagree });
  console.log({ agree, disagree, total: agree + disagree, memberCount,
    참여율: memberCount ? Math.round((agree + disagree) / memberCount * 100) + '%' : '-' });
}

const [cmd, arg] = process.argv.slice(2);
(cmd === 'import' && arg ? importMembers(arg) : cmd === 'tally' ? tally() : Promise.reject(new Error('사용법: node admin.js import members.csv | tally')))
  .catch(e => { console.error(e.message); process.exit(1); });
