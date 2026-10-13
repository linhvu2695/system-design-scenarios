import * as simulation from './sim.js';

export default {
  category: 'database',
  topic: { en: 'Sharding', vi: 'Sharding' },
  title: {
    en: 'Forty thousand stores, one primary',
    vi: 'Bốn mươi nghìn cửa hàng, một primary',
  },

  scenario: {
    en: `You run the database of a commerce platform. About **40,000 merchants** run online stores on it, and every order, refund and payout lives in one Postgres primary. It is close to the write limit of the biggest machine you can buy, so the orders data has to be split across several database servers (shards).

What the data and the business look like:
- **Nearly every query is about one merchant.** The merchant dashboard, order search, refunds, sales reports and a shopper's order page all start from a merchant.
- **Merchants are wildly uneven.** A few dozen large stores produce a big share of all orders, and a flash sale can multiply one store's traffic many times over for an hour.
- Order ids come from one global sequence, so **new orders always get the highest ids**.
- New contract terms: **EU merchants' data must be stored on servers in the EU** from next year.
- The largest merchant is paying for a **dedicated database server** of its own.
- You will add shards as you grow, and you must be able to move data while stores stay open.`,
    vi: `Bạn vận hành database của một nền tảng thương mại. Khoảng **40.000 người bán (merchant)** mở cửa hàng online trên đó, và mọi đơn hàng, hoàn tiền, thanh toán đều nằm trên một Postgres primary. Nó đã gần chạm giới hạn ghi của cỗ máy lớn nhất bạn có thể mua, nên dữ liệu đơn hàng phải được chia ra nhiều database server (shard).

Dữ liệu và việc kinh doanh trông thế này:
- **Gần như mọi truy vấn đều xoay quanh một merchant.** Dashboard của merchant, tìm đơn, hoàn tiền, báo cáo doanh thu và trang đơn hàng của người mua đều bắt đầu từ một merchant.
- **Các merchant chênh lệch rất lớn.** Vài chục cửa hàng lớn tạo ra phần lớn đơn hàng, và một đợt flash sale có thể làm lưu lượng của một cửa hàng tăng gấp nhiều lần trong một giờ.
- Mã đơn hàng lấy từ một sequence toàn cục, nên **đơn mới luôn có mã lớn nhất**.
- Điều khoản hợp đồng mới: từ năm sau, **dữ liệu của merchant EU phải nằm trên server đặt tại EU**.
- Merchant lớn nhất đang trả tiền để có **một database server riêng**.
- Bạn sẽ thêm shard khi phát triển, và phải di chuyển được dữ liệu trong khi cửa hàng vẫn mở.`,
  },

  question: {
    en: 'How do you decide which shard an order lives on?',
    vi: 'Bạn quyết định một đơn hàng nằm trên shard nào bằng cách nào?',
  },

  options: [
    {
      id: 'A',
      text: {
        en: 'Range sharding on order id: each shard owns a range of ids (1 to 50 million, 50 to 100 million, and so on), split further as ranges grow.',
        vi: 'Range sharding theo mã đơn: mỗi shard sở hữu một khoảng mã (1 đến 50 triệu, 50 đến 100 triệu, v.v.), chia nhỏ thêm khi khoảng đó lớn lên.',
      },
      why: {
        en: 'Ids only go up, so every new order lands in the last range: one shard takes all the writes while the others hold history, which is the write limit you were trying to escape. And a merchant\'s orders are spread across every range it has ever sold in, so its dashboard reads from many shards. Placement follows the id, so there is no way to keep EU merchants on EU servers or give one merchant its own. Range sharding shines when queries scan ranges of the key itself (time-series, logs) and the key does not only grow.',
        vi: 'Mã chỉ tăng, nên mọi đơn mới rơi vào khoảng cuối cùng: một shard gánh toàn bộ lượt ghi trong khi các shard khác giữ lịch sử, đúng cái giới hạn ghi bạn đang muốn thoát. Và đơn của một merchant rải trên mọi khoảng mà nó từng bán, nên dashboard của nó phải đọc từ nhiều shard. Vị trí đi theo mã, nên không cách nào giữ merchant EU trên server EU hay cho một merchant server riêng. Range sharding phát huy khi truy vấn quét theo khoảng của chính khoá đó (dữ liệu chuỗi thời gian, log) và khoá không chỉ tăng dần.',
      },
    },
    {
      id: 'B',
      text: {
        en: 'Hash sharding on order id: send each order to shard `hash(order_id) mod N`.',
        vi: 'Hash sharding theo mã đơn: gửi mỗi đơn tới shard `hash(order_id) mod N`.',
      },
      why: {
        en: 'Writes spread evenly, which fixes the hot shard. But it scatters every merchant across all shards: listing one store\'s orders, searching them or building its sales report has to ask every shard and merge the results, so each shard you add makes those queries wider, not cheaper. With `mod N`, adding a shard changes the result for most ids, so most of the data moves. And as with ranges, the hash decides placement, so EU residency and a dedicated server for one merchant are impossible. Hashing the id fits lookups by that id alone, like a session store.',
        vi: 'Lượt ghi được rải đều, nên hết shard nóng. Nhưng nó rải mọi merchant ra khắp các shard: liệt kê đơn của một cửa hàng, tìm kiếm chúng hay dựng báo cáo doanh thu đều phải hỏi mọi shard rồi gộp kết quả, nên mỗi shard thêm vào làm các truy vấn đó rộng hơn chứ không rẻ hơn. Với `mod N`, thêm một shard làm thay đổi kết quả của phần lớn mã, nên phần lớn dữ liệu phải di chuyển. Và cũng như range, hàm hash quyết định vị trí, nên yêu cầu lưu trữ ở EU và server riêng cho một merchant là không thể. Hash theo mã hợp với các tra cứu chỉ bằng chính mã đó, như session store.',
      },
    },
    {
      id: 'C',
      text: {
        en: 'Consistent hashing on merchant id: put the shards on a hash ring with virtual nodes; each merchant (and all its orders) goes to the next shard clockwise from its hash.',
        vi: 'Consistent hashing theo merchant id: đặt các shard lên một vòng hash với virtual node; mỗi merchant (cùng mọi đơn của nó) đi tới shard kế tiếp theo chiều kim đồng hồ tính từ giá trị hash của nó.',
      },
      why: {
        en: 'Much better: each merchant lives on one shard, so its queries stay on one server, and adding a shard moves only about 1/N of the merchants. What it cannot do is let you choose. The hash puts each EU merchant wherever its hash lands, often on a server outside the EU. The largest merchant shares whatever shard its hash picks and cannot be moved to its own server, and a flash sale at a big store heats one shard with no way to move that store away. Running a separate ring per region would need a rule saying which ring each merchant is on, which is a directory. Consistent hashing is the right call for many small, similar keys on nodes that come and go, as in Dynamo and Cassandra.',
        vi: 'Tốt hơn nhiều: mỗi merchant nằm trên một shard, nên truy vấn của nó ở trên một server, và thêm một shard chỉ di chuyển khoảng 1/N số merchant. Điều nó không làm được là cho bạn chọn. Hàm hash đặt mỗi merchant EU vào đâu tuỳ giá trị hash, thường là một server ngoài EU. Merchant lớn nhất ở chung shard mà hash của nó chọn và không thể dời sang server riêng, và một đợt flash sale ở cửa hàng lớn làm nóng một shard mà không cách nào chuyển cửa hàng đó đi. Chạy mỗi vùng một vòng riêng thì cần một quy tắc nói merchant nào ở vòng nào, tức là một directory. Consistent hashing là lựa chọn đúng cho rất nhiều khoá nhỏ, giống nhau, trên các node đến và đi liên tục, như Dynamo và Cassandra.',
      },
    },
    {
      id: 'D',
      text: {
        en: 'Directory-based sharding on merchant id: keep a lookup table `merchant_id → shard`, cached by the app; place new merchants by rule (region, size) and move a merchant by copying its rows, then updating its entry.',
        vi: 'Directory-based sharding theo merchant id: giữ một bảng tra cứu `merchant_id → shard`, được app cache lại; đặt merchant mới theo quy tắc (vùng, quy mô) và di chuyển một merchant bằng cách sao chép dữ liệu của nó rồi cập nhật dòng tương ứng.',
      },
      why: {
        en: 'Every merchant query goes to exactly one shard, and you decide which. EU merchants are placed on EU shards by rule. The largest merchant gets a shard of its own. A store that outgrows its shard, or a shard that runs hot, is fixed by moving individual merchants: copy the merchant\'s rows to the new shard, keep them in sync, then flip its directory entry. A new shard takes merchants you choose, not whatever a hash hands it. The costs: the directory sits on every request\'s path, so it must be cached and highly available (at 40,000 rows it fits in memory easily), and you need a reliable copy-and-cut-over tool. Shopify routes each shop to its pod through a routing table and moves shops between shards this way.',
        vi: 'Mọi truy vấn của một merchant đi tới đúng một shard, và bạn quyết định shard nào. Merchant EU được đặt vào shard EU theo quy tắc. Merchant lớn nhất có shard riêng. Một cửa hàng lớn vượt shard của nó, hay một shard bị nóng, được xử lý bằng cách di chuyển từng merchant: sao chép dữ liệu của merchant sang shard mới, giữ đồng bộ, rồi đổi dòng của nó trong directory. Shard mới nhận những merchant bạn chọn, chứ không phải bất cứ thứ gì hàm hash đưa cho. Cái giá: directory nằm trên đường đi của mọi request, nên nó phải được cache và luôn sẵn sàng cao (40.000 dòng thì nằm gọn trong bộ nhớ), và bạn cần một công cụ sao chép và chuyển đổi đáng tin cậy. Shopify định tuyến mỗi shop tới pod của nó qua một routing table và di chuyển shop giữa các shard theo cách này.',
      },
    },
  ],

  answer: 'D',

  takeaway: {
    en: `Sharding is two decisions: **which key** keeps a query on one shard, and **who decides** where that key lives.

- Pick the key your queries start from. Here that is the merchant, not the order. Sharding on the order id, by range or hash, scatters every merchant.
- **Range**: keeps neighbouring keys together. Great for range scans, but an ever-growing key makes the last shard hot.
- **Hash** (\`mod N\`): spreads evenly; adding a shard moves almost everything.
- **Consistent hashing**: spreads evenly and moves only ~1/N when shards change, but the hash still decides placement.
- **Directory**: you decide placement per key, which is what residency rules, very large tenants and per-tenant moves need. The price is a lookup on every request and a tool to move tenants.`,
    vi: `Sharding gồm hai quyết định: **khoá nào** giữ một truy vấn trên một shard, và **ai quyết định** khoá đó nằm ở đâu.

- Chọn khoá mà truy vấn của bạn bắt đầu từ đó. Ở đây là merchant, không phải đơn hàng. Shard theo mã đơn, dù theo range hay hash, đều rải mọi merchant ra khắp nơi.
- **Range**: giữ các khoá gần nhau ở cùng chỗ. Rất tốt cho quét theo khoảng, nhưng khoá chỉ tăng làm shard cuối bị nóng.
- **Hash** (\`mod N\`): rải đều; thêm một shard làm gần như mọi thứ phải di chuyển.
- **Consistent hashing**: rải đều và chỉ di chuyển khoảng 1/N khi số shard thay đổi, nhưng hàm hash vẫn quyết định vị trí.
- **Directory**: bạn quyết định vị trí cho từng khoá, đúng thứ mà quy định lưu trữ theo vùng, tenant rất lớn và việc di chuyển từng tenant cần. Cái giá là một lần tra cứu trên mỗi request và một công cụ để di chuyển tenant.`,
  },

  sources: [
    { title: 'Shopify Engineering: Shard Balancing, Moving Shops Confidently with Zero-Downtime at Terabyte-scale', url: 'https://shopify.engineering/mysql-database-shard-balancing-terabyte-scale' },
    { title: 'MongoDB documentation: Hashed Sharding', url: 'https://www.mongodb.com/docs/manual/core/hashed-sharding/' },
    { title: 'Apache Cassandra documentation: Dynamo (consistent hashing and virtual nodes)', url: 'https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html' },
    { title: 'Vitess documentation: Vindexes (lookup vindexes)', url: 'https://vitess.io/docs/reference/features/vindexes/' },
  ],

  simulation,
};
