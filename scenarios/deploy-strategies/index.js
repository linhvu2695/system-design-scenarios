import * as simulation from './sim.js';

export default {
  category: 'reliability',
  topic: { en: 'Deploy strategies', vi: 'Chiến lược deploy' },
  title: {
    en: 'A new tax engine, and payslips you cannot recall',
    vi: 'Engine tính thuế mới, và những phiếu lương không thể thu hồi',
  },

  scenario: {
    en: `You run a payroll SaaS for **4,000 companies**. The team has rewritten the **tax calculation engine**: the code that decides how much tax goes on every payslip. It passed the test suite, and on a year of replayed pay runs the new and old engines agree on 99.97% of payslips. The 0.03% is either a bug or the old engine's bug, and nobody is sure yet.

The service runs as stateless containers behind a load balancer, and you can deploy several times a day.

Constraints:
- **A payslip cannot be recalled.** Once issued, it is a legal document the employee has been paid against. A wrong one means a correction run, an apology, and sometimes a fine. Keep the number of customers who could receive a wrong payslip as small as possible.
- **Your 40 enterprise customers stay on the old engine** until each signs off on the change. Their contracts give them a review window.
- **One pay run, one engine.** A company runs payroll for all its employees at once. If some payslips in a run come from the old engine and some from the new one, totals and year-to-date figures stop adding up.
- If something looks wrong, traffic must be back on the old engine **within seconds**, not after a redeploy.
- Your own staff run payroll through the product too, and are happy to go first.`,
    vi: `Bạn vận hành một SaaS tính lương cho **4.000 công ty**. Đội ngũ đã viết lại **engine tính thuế**: phần code quyết định mỗi phiếu lương bị trừ bao nhiêu thuế. Nó vượt qua bộ test, và khi chạy lại một năm dữ liệu trả lương, engine mới và cũ cho kết quả giống nhau ở 99,97% phiếu lương. 0,03% còn lại hoặc là bug, hoặc là bug của engine cũ, và chưa ai chắc chắn.

Dịch vụ chạy dưới dạng container stateless phía sau một load balancer, và bạn có thể deploy nhiều lần mỗi ngày.

Ràng buộc:
- **Phiếu lương không thể thu hồi.** Khi đã phát hành, nó là chứng từ pháp lý mà nhân viên đã được trả theo đó. Một phiếu sai nghĩa là một đợt chạy điều chỉnh, một lời xin lỗi, và đôi khi bị phạt. Hãy giữ số khách hàng có thể nhận phiếu sai ở mức nhỏ nhất.
- **40 khách hàng enterprise phải ở lại engine cũ** cho tới khi từng người ký chấp thuận thay đổi. Hợp đồng cho họ một khoảng thời gian xem xét.
- **Một đợt trả lương, một engine.** Một công ty chạy lương cho toàn bộ nhân viên cùng lúc. Nếu một số phiếu trong đợt đến từ engine cũ và một số từ engine mới, tổng cộng và số luỹ kế từ đầu năm sẽ không còn khớp.
- Nếu có gì bất thường, traffic phải quay về engine cũ **trong vài giây**, không phải sau một lần deploy lại.
- Nhân viên của chính bạn cũng chạy lương qua sản phẩm, và sẵn lòng dùng thử trước.`,
  },

  question: {
    en: 'How do you release the new engine?',
    vi: 'Bạn phát hành engine mới thế nào?',
  },

  options: [
    {
      id: 'A',
      text: {
        en: 'Ship the new engine dark to every server behind a feature flag evaluated per account: on for internal staff first, then 5% → 25% → 50% → 100% of regular accounts, with enterprise accounts excluded by a rule and a kill switch to turn it off.',
        vi: 'Đưa engine mới lên mọi server ở trạng thái tắt, sau một feature flag được đánh giá theo từng tài khoản: bật cho nhân viên nội bộ trước, rồi 5% → 25% → 50% → 100% tài khoản thường, loại trừ tài khoản enterprise bằng một rule và có kill switch để tắt.',
      },
      why: {
        en: 'It separates deploying the code from releasing it, and routes by **who** the request is for, not by which server it reaches. Your own staff meet a bad engine first, so a bug usually costs you an internal correction instead of a customer\'s payslip. Because the flag is evaluated per account, a company is either on the new engine or not: every payslip in a pay run comes from the same engine, and an enterprise account is never on it until you add it to the rule. Turning the flag off takes effect on the next request, with no deploy. The kill switch cannot recall payslips already issued; it can only keep the number small, which is why the rollout starts with the people who can tolerate a correction.',
        vi: 'Nó tách việc deploy code khỏi việc phát hành nó, và định tuyến theo việc request là **của ai**, không theo server nào nhận nó. Nhân viên của bạn gặp engine lỗi đầu tiên, nên một bug thường chỉ khiến bạn phải điều chỉnh nội bộ thay vì sai phiếu lương của khách. Vì flag được đánh giá theo tài khoản, một công ty hoặc ở engine mới, hoặc không: mọi phiếu trong một đợt trả lương đều từ cùng một engine, và một tài khoản enterprise không bao giờ ở engine mới cho tới khi bạn thêm nó vào rule. Tắt flag có hiệu lực ngay ở request tiếp theo, không cần deploy. Kill switch không thu hồi được những phiếu đã phát hành; nó chỉ giữ cho con số đó nhỏ, vì vậy việc phát hành bắt đầu từ những người chịu được một lần điều chỉnh.',
      },
    },
    {
      id: 'B',
      text: {
        en: 'Blue/green: stand up a second environment running the new engine, smoke-test it, then switch the load balancer from blue to green. If anything goes wrong, switch back.',
        vi: 'Blue/green: dựng một môi trường thứ hai chạy engine mới, smoke test, rồi chuyển load balancer từ blue sang green. Nếu có gì sai, chuyển lại.',
      },
      why: {
        en: 'The switch back is fast, and every pay run lands on one environment or the other. But the switch is all or nothing. At the moment of the flip, every customer, the 40 enterprise accounts included, is on the new engine, and a bug that the smoke test missed hits every payslip issued until someone notices and flips back. A fast rollback limits how long the damage lasts; it does nothing about how many customers it reaches. Blue/green suits releases where the risk is the deploy itself (configuration, infrastructure, a new runtime), not the behaviour of the code.',
        vi: 'Việc chuyển lại diễn ra nhanh, và mỗi đợt trả lương đều rơi vào trọn một môi trường. Nhưng việc chuyển là tất cả hoặc không gì cả. Ngay khi chuyển, mọi khách hàng, kể cả 40 tài khoản enterprise, đều ở engine mới, và một bug mà smoke test bỏ sót sẽ ảnh hưởng mọi phiếu lương phát hành cho tới khi có người phát hiện và chuyển lại. Rollback nhanh giới hạn thời gian thiệt hại kéo dài; nó không giới hạn số khách hàng bị ảnh hưởng. Blue/green hợp với các bản phát hành mà rủi ro nằm ở chính việc deploy (cấu hình, hạ tầng, runtime mới), không phải ở hành vi của code.',
      },
    },
    {
      id: 'C',
      text: {
        en: 'Canary: send 5% of requests to servers running the new engine, watch error rates and tax totals, then raise the load balancer weight to 25%, 50% and 100%.',
        vi: 'Canary: gửi 5% request tới các server chạy engine mới, theo dõi tỉ lệ lỗi và tổng thuế, rồi tăng trọng số của load balancer lên 25%, 50% và 100%.',
      },
      why: {
        en: 'It limits how much traffic a bug can reach and rolls back in seconds by setting the weight to zero: on blast radius alone it is far better than blue/green. But a load balancer splits **requests**, not customers. With 5% of requests on the new engine, every company sends some of its requests there, so an enterprise account is on the new engine from the first minute, and a pay run of hundreds of payslips is split between the two engines. Sticky sessions do not fix this: a pay run is a batch job, not one user\'s session. A weighted canary is the right tool when any request can safely go to either version.',
        vi: 'Nó giới hạn lượng traffic mà một bug có thể chạm tới và rollback trong vài giây bằng cách đặt trọng số về 0: riêng về phạm vi ảnh hưởng thì nó tốt hơn blue/green nhiều. Nhưng load balancer chia **request**, không chia khách hàng. Với 5% request ở engine mới, công ty nào cũng có một số request đi tới đó, nên một tài khoản enterprise đã ở engine mới ngay từ phút đầu, và một đợt trả lương hàng trăm phiếu bị chia giữa hai engine. Sticky session không giải quyết được: một đợt trả lương là batch job, không phải session của một người dùng. Canary theo trọng số là công cụ đúng khi mọi request đều có thể an toàn đi tới phiên bản nào cũng được.',
      },
    },
    {
      id: 'D',
      text: {
        en: 'Rolling update: replace the containers one at a time with the new version until every one runs the new engine. If something breaks, roll the old image back out.',
        vi: 'Rolling update: thay từng container một bằng phiên bản mới cho tới khi mọi container đều chạy engine mới. Nếu có gì hỏng, triển khai lại image cũ.',
      },
      why: {
        en: 'It is the default in most orchestrators and needs no extra capacity, but it gives you no control over who gets the new engine. Requests land on whichever container the load balancer picks, so while the rollout runs, old and new serve every customer side by side: enterprise accounts included, and pay runs split. Rolling back is another rolling deploy, minutes rather than seconds, and the share of traffic on the bad version keeps growing until it is caught. Rolling updates suit changes where old and new versions are interchangeable.',
        vi: 'Đây là mặc định của hầu hết các orchestrator và không cần thêm tài nguyên, nhưng nó không cho bạn kiểm soát ai nhận engine mới. Request rơi vào container nào load balancer chọn, nên trong lúc triển khai, bản cũ và mới cùng phục vụ mọi khách hàng: kể cả tài khoản enterprise, và các đợt trả lương bị chia đôi. Rollback lại là một lần rolling deploy nữa, mất vài phút thay vì vài giây, và phần traffic ở phiên bản lỗi cứ tăng dần cho tới khi bị phát hiện. Rolling update hợp với các thay đổi mà phiên bản cũ và mới có thể thay thế cho nhau.',
      },
    },
  ],

  answer: 'A',

  takeaway: {
    en: `**Deploying code and releasing behaviour are two different steps.** Deploy strategies decide which servers run the new code; feature flags decide which users get the new behaviour.

- **Blue/green:** all traffic switches at once, and switches back fast. Good for infrastructure and runtime changes; no control over who is exposed.
- **Canary (load balancer weights):** a small share of *requests* first, ramped up while you watch metrics. Good blast-radius control, but it splits requests, so the same customer sees both versions.
- **Rolling:** containers replaced one by one. No extra capacity, no routing control, and rollback is another deploy.
- **Feature flags keyed by account or user:** route by *who*, keep sticky per customer, exclude groups by rule, start with internal users, and turn off without a deploy.
- A fast rollback limits **how long** a bug runs; only a small, chosen first audience limits **how many** it reaches. For effects you cannot undo, you need both.
- Keep flags short-lived: once the new engine is everywhere, delete the flag and the old path.`,
    vi: `**Deploy code và phát hành hành vi là hai bước khác nhau.** Chiến lược deploy quyết định server nào chạy code mới; feature flag quyết định người dùng nào nhận hành vi mới.

- **Blue/green:** toàn bộ traffic chuyển cùng lúc, và chuyển lại nhanh. Hợp với thay đổi hạ tầng và runtime; không kiểm soát được ai bị ảnh hưởng.
- **Canary (trọng số load balancer):** một phần nhỏ *request* đi trước, tăng dần trong khi bạn theo dõi chỉ số. Kiểm soát phạm vi ảnh hưởng tốt, nhưng nó chia request, nên cùng một khách hàng thấy cả hai phiên bản.
- **Rolling:** thay từng container một. Không cần thêm tài nguyên, không kiểm soát định tuyến, và rollback là một lần deploy nữa.
- **Feature flag theo tài khoản hoặc người dùng:** định tuyến theo *ai*, cố định theo từng khách hàng, loại trừ nhóm bằng rule, bắt đầu với người dùng nội bộ, và tắt mà không cần deploy.
- Rollback nhanh giới hạn bug chạy **bao lâu**; chỉ một nhóm đầu tiên nhỏ và được chọn kỹ mới giới hạn bug chạm tới **bao nhiêu** người. Với những tác động không thể hoàn tác, bạn cần cả hai.
- Giữ flag ngắn hạn: khi engine mới đã có mặt ở mọi nơi, hãy xoá flag và nhánh code cũ.`,
  },

  sources: [
    { title: 'Martin Fowler: Feature Toggles (aka Feature Flags), by Pete Hodgson', url: 'https://martinfowler.com/articles/feature-toggles.html' },
    { title: 'Martin Fowler: BlueGreenDeployment', url: 'https://martinfowler.com/bliki/BlueGreenDeployment.html' },
    { title: 'Martin Fowler: CanaryRelease, by Danilo Sato', url: 'https://martinfowler.com/bliki/CanaryRelease.html' },
    { title: 'Kubernetes documentation: Performing a Rolling Update', url: 'https://kubernetes.io/docs/tutorials/kubernetes-basics/update/update-intro/' },
    { title: 'Google SRE Workbook: Canarying Releases', url: 'https://sre.google/workbook/canarying-releases/' },
  ],

  simulation,
};
