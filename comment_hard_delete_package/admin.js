// 관리자용 스크립트 (본인 PC에서만 실행. serviceAccount.json 은 절대 GitHub에 올리지 마세요)
//   npm i firebase-admin
//   node admin.js import members.csv        # 조합원 명부 등록 (CSV: 이름,휴대폰뒤4자리)
//   node admin.js tally                     # 투표 집계 → meta/result 저장
//   node admin.js reset                     # 투표·집계 초기화
//   node admin.js migrate-authors members.csv  # 예전 댓글 authorId → 현재 명부 authorId 로 이전
//   node admin.js purge-deleted-comments      # 기존 soft delete 댓글 문서 완전 삭제
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SALT = 'makingsaltforthefirsttime'; // index.html 의 SALT와 반드시 동일하게

const saPath = path.join(__dirname, 'serviceAccount.json');
if (!fs.existsSync(saPath)) {
  console.error('serviceAccount.json 이 없습니다. 이 파일과 같은 폴더에 두세요.');
  console.error('Firebase Console → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));
} catch (e) {
  console.error('serviceAccount.json 을 읽지 못했습니다. JSON 형식을 확인하세요.');
  process.exit(1);
}

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

async function importMembers(file) {
  const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  const seen = new Set();
  let added = 0, kept = 0, bad = 0;
  for (const line of lines) {
    const [rawName, rawPhone] = line.split(',').map(s => (s || '').trim());
    if (rawName === '이름') continue; // 헤더
    const name = rawName.normalize('NFC').replace(/\s+/g, '');
    const phone = (rawPhone || '').replace(/\D/g, '');
    if (!name || phone.length !== 4) { console.warn('형식 오류, 건너뜀:', line); bad++; continue; }
    const key = sha(`${SALT}|${name}|${phone}`);
    if (seen.has(key)) { console.warn('이름+휴대폰뒤4자리 중복(동명이인?), 건너뜀:', line); bad++; continue; }
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
    tallyAt: FieldValue.serverTimestamp()
  });
  await db.doc('meta/tally').set({ agree, disagree });
  console.log({ agree, disagree, total: agree + disagree, memberCount });
}

async function resetVotes() {
  const votes = await db.collection('votes').get();
  const batchSize = 400;
  let batch = db.batch(), n = 0;
  for (const d of votes.docs) {
    batch.delete(d.ref);
    n++;
    if (n % batchSize === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (n % batchSize !== 0) await batch.commit();
  await db.doc('meta/tally').set({ agree: 0, disagree: 0 });
  const result = await db.doc('meta/result').get();
  if (result.exists) {
    await db.doc('meta/result').set({
      agree: 0, disagree: 0, total: 0,
      memberCount: result.data().memberCount || 0,
      tallyAt: FieldValue.serverTimestamp()
    });
  }
  console.log(`투표 ${n}건 삭제, tally 초기화 완료`);
}

// 생년월일 로그인 → 휴대폰 로그인 전환 후, 예전 authorId 로 작성된 댓글을
// 현재 명부(휴대폰 기준) authorId 로 맞춰 수정·삭제가 다시 보이게 함
async function migrateAuthors(file) {
  const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  const canonicalByName = new Map(); // 정규화 이름 → { key, authorId, rawName }

  for (const line of lines) {
    const [rawName, rawPhone] = line.split(',').map(s => (s || '').trim());
    if (rawName === '이름') continue;
    const name = rawName.normalize('NFC').replace(/\s+/g, '');
    const phone = (rawPhone || '').replace(/\D/g, '');
    if (!name || phone.length !== 4) continue;
    const key = sha(`${SALT}|${name}|${phone}`);
    const snap = await db.collection('members').doc(key).get();
    if (!snap.exists) {
      console.warn('명부에 없음(import 먼저):', rawName, phone);
      continue;
    }
    const authorId = snap.data().authorId;
    if (!authorId) {
      console.warn('authorId 없음:', rawName);
      continue;
    }
    canonicalByName.set(name, { key, authorId, rawName });
  }
  console.log(`현재 명부 기준 ${canonicalByName.size}명`);

  // 같은 이름의 다른 members 문서(예전 생년월일 키 등) → 옛 authorId 수집
  const authorIdMap = new Map(); // oldAuthorId → newAuthorId
  const allMembers = await db.collection('members').get();
  let oldMemberCount = 0;
  allMembers.forEach(d => {
    const data = d.data();
    const name = String(data.name || '').normalize('NFC').replace(/\s+/g, '');
    const can = canonicalByName.get(name);
    if (!can) return;
    if (d.id === can.key) return; // 이미 현재 키
    if (data.authorId && data.authorId !== can.authorId) {
      authorIdMap.set(data.authorId, can.authorId);
      oldMemberCount++;
    }
  });
  console.log(`이전 대상 authorId ${authorIdMap.size}개 (옛 members 문서 ${oldMemberCount}건)`);

  if (authorIdMap.size === 0) {
    console.log('이전할 authorId 가 없습니다. 이미 맞춰져 있거나 옛 명부 문서가 없습니다.');
    return;
  }

  const comments = await db.collection('comments').get();
  let updated = 0, skipped = 0;
  const batchSize = 400;
  let batch = db.batch(), n = 0;
  for (const d of comments.docs) {
    const old = d.data().authorId;
    if (!old || !authorIdMap.has(old)) { skipped++; continue; }
    batch.update(d.ref, { authorId: authorIdMap.get(old) });
    updated++;
    n++;
    if (n % batchSize === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (n % batchSize !== 0) await batch.commit();
  console.log(`댓글 authorId 이전 완료: ${updated}건 (해당 없음 ${skipped}건)`);
  console.log('브라우저에서 새로고침 후 본인 예전 댓글에 수정·삭제가 보여야 합니다.');
}


// 기존에 deleted:true 로 남아 있던 댓글 문서를 일괄 완전 삭제
async function purgeDeletedComments() {
  const snap = await db.collection('comments').where('deleted', '==', true).get();
  const batchSize = 400;
  let batch = db.batch(), count = 0;

  for (const d of snap.docs) {
    batch.delete(d.ref);
    count++;
    if (count % batchSize === 0) {
      await batch.commit();
      batch = db.batch();
    }
  }
  if (count % batchSize !== 0) await batch.commit();
  console.log(`기존 삭제 댓글 ${count}건 완전 삭제 완료`);
}

const [cmd, arg] = process.argv.slice(2);
const run =
  cmd === 'import' && arg ? importMembers(arg) :
  cmd === 'tally' ? tally() :
  cmd === 'reset' ? resetVotes() :
  cmd === 'migrate-authors' && arg ? migrateAuthors(arg) :
  cmd === 'purge-deleted-comments' ? purgeDeletedComments() :
  Promise.reject(new Error('사용법: node admin.js import members.csv | tally | reset | migrate-authors members.csv | purge-deleted-comments'));

run.catch(e => { console.error(e.message || e); process.exit(1); });
