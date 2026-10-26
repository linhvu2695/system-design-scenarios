/* Two languages, two mechanisms.

   UI text is English in the code: wrap it in t() and add its Vietnamese to VI below.
   A missing entry falls back to English (tests/i18n.test.js catches it).

   Scenario content is written in both languages side by side as { en, vi } and read
   with tx(). Nothing is machine-translated at runtime.

   The choice is a per-browser convenience, so localStorage is enough (and may be blocked). */

const KEY = 'sds-lang';

export const VI = {
  'System design · Interactive scenarios': 'Thiết kế hệ thống · Tình huống tương tác',
  'Each scenario is a situation from a real system with four possible calls. Play with the simulation, make your call, then see why each option holds up or falls apart.':
    'Mỗi tình huống lấy từ một hệ thống thực tế, với bốn hướng xử lý. Thử mô phỏng, đưa ra lựa chọn, rồi xem vì sao từng phương án đứng vững hay sụp đổ.',
  'No scenarios yet. Run make new ID=<name> to add one.': 'Chưa có tình huống nào. Chạy make new ID=<tên> để thêm.',
  'All scenarios': 'Tất cả tình huống',
  'All': 'Tất cả',
  'Categories': 'Danh mục',
  'Scenario {n}': 'Tình huống {n}',
  'The situation': 'Tình huống',
  'Explore': 'Thử nghiệm',
  'Your call': 'Bạn chọn gì?',
  'Answers': 'Các đáp án',
  'Check answer': 'Kiểm tra',
  'Try again': 'Làm lại',
  'Correct.': 'Chính xác.',
  'Not quite. The answer is {x}.': 'Chưa đúng. Đáp án là {x}.',
  'Why this works': 'Vì sao đúng',
  'Why not': 'Vì sao không',
  'Takeaway': 'Điều cần nhớ',
  'Sources': 'Nguồn tham khảo',
  'Previous': 'Trước',
  'Next': 'Tiếp',
  'Pick an answer, then check it. Keys A–D and Enter work too.': 'Chọn một đáp án rồi bấm Kiểm tra. Có thể dùng phím A–D và Enter.',
  '{c} of {n} solved': '{c}/{n} đã giải',
  'Solved': 'Đã giải',
  'Missed': 'Chưa đúng',
  'New': 'Mới',
  'This simulation failed to load.': 'Không tải được mô phỏng này.',
  'What goes wrong': 'Điều gì trục trặc',
  'How you handle it': 'Bạn xử lý thế nào',
  'Survives this situation': 'Vượt qua tình huống này',
  'Breaks in this situation': 'Hỏng trong tình huống này',
  'Speed': 'Tốc độ',
  'Play': 'Phát',
  'Pause': 'Tạm dừng',
  'Step': 'Từng bước',
  'Step {n} of {total}': 'Bước {n}/{total}',
  'Replay': 'Chạy lại',
  'What happened': 'Diễn biến',
  'Scoreboard: fills in as you watch each run': 'Bảng điểm: tự điền khi bạn xem từng lần chạy',
  'Make your call below to unlock the other setups.': 'Trả lời câu hỏi bên dưới để mở khoá các cách làm còn lại.',
  'Topics inspired by': 'Chủ đề lấy cảm hứng từ',
  'by': 'của',
  'Scenarios, explanations and simulations are written for this project.':
    'Tình huống, lời giải thích và mô phỏng được viết riêng cho dự án này.',
};

const initial = () => {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'vi' || saved === 'en') return saved;
  } catch { /* blocked storage: fall through to the browser language */ }
  return String(globalThis.navigator?.language || '').toLowerCase().startsWith('vi') ? 'vi' : 'en';
};

export let LANG = initial();

export const t = (s, vars = {}) => {
  const out = (LANG === 'vi' && VI[s]) || s;
  return out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
};

/* Content is { en, vi }; fall back to the other language rather than show nothing. */
export const tx = v => v == null ? '' : typeof v === 'string' ? v : (v[LANG] || v.en || v.vi || '');

const listeners = [];
export const onLang = fn => { listeners.push(fn); };

export function setLang(l) {
  LANG = l;
  try { localStorage.setItem(KEY, l); } catch { /* private mode: still switches for this page */ }
  document.documentElement.lang = l;
  listeners.forEach(fn => fn());
}

/* Inline SVG, not emoji: Windows renders flag emoji as the letters "VN" / "GB". */
export const FLAGS = {
  vi: '<svg viewBox="0 0 30 20" aria-hidden="true"><rect width="30" height="20" fill="#da251d"/>'
    + '<polygon fill="#ffdd00" points="15,3.6 16.35,7.75 20.7,7.75 17.18,10.3 18.52,14.45 15,11.9 11.48,14.45 12.82,10.3 9.3,7.75 13.65,7.75"/></svg>',
  en: '<svg viewBox="0 0 60 30" aria-hidden="true"><clipPath id="uk-s"><path d="M0,0v30h60v-30z"/></clipPath>'
    + '<clipPath id="uk-t"><path d="M30,15h30v15zv15h-30zh-30v-15zv-15h30z"/></clipPath><g clip-path="url(#uk-s)">'
    + '<path d="M0,0v30h60v-30z" fill="#012169"/><path d="M0,0L60,30M60,0L0,30" stroke="#fff" stroke-width="6"/>'
    + '<path d="M0,0L60,30M60,0L0,30" clip-path="url(#uk-t)" stroke="#c8102e" stroke-width="4"/>'
    + '<path d="M30,0v30M0,15h60" stroke="#fff" stroke-width="10"/><path d="M30,0v30M0,15h60" stroke="#c8102e" stroke-width="6"/></g></svg>',
};
