import * as simulation from './sim.js';

export default {
  category: 'queue',
  topic: { en: 'Retries and dead-letter queues', vi: 'Retry và dead-letter queue' },
  title: {
    en: '“Your driver is here,” said nobody',
    vi: '“Tài xế đã tới”, chẳng ai báo',
  },

  scenario: {
    en: `You run the notifier of a food delivery app. The delivery service publishes every driver update ("picked up", "5 minutes away", "at your door") to a Kafka topic with **12 partitions**, about **60 messages a second** in the evening. A consumer group of 12 reads it and sends each update as an SMS through a provider's HTTP API, then commits its offset.

How the consumer handles errors today: it sends as fast as it reads. If a send fails, it retries **straight away, up to 3 times**, then logs the error and moves on.

Last Friday:
- The SMS provider was **down for 10 minutes** (every request got \`503\`). Every message in those 10 minutes failed 3 times within a second and was dropped. **About 36,000 customers never got their texts.**
- When it came back, the consumers raced through the backlog far faster than the provider allows and got a wall of \`429 Too Many Requests\`.
- Separately, a few messages a day carry a phone number the provider rejects with \`400\`. They are retried and dropped. Nobody knows which ones.

Constraints:
- **No message may be silently lost.** It is either delivered or handed somewhere a person is alerted and can replay it.
- The provider accepts **120 requests a second** on your account. If more than **2% of your requests** in an hour go over that, it throttles the account for the rest of the hour.
- **Once the provider is back, texts must go out within about 30 seconds.** A "driver at your door" text later than that is useless.
- Consumers are **redeployed several times a day**.
- Texts for the same order may arrive out of order; each one says what it is about.`,
    vi: `Bạn vận hành dịch vụ gửi thông báo của một ứng dụng giao đồ ăn. Delivery service publish mọi cập nhật của tài xế ("đã lấy hàng", "còn 5 phút", "đang ở trước cửa") vào một Kafka topic có **12 partition**, khoảng **60 tin mỗi giây** vào buổi tối. Một consumer group gồm 12 consumer đọc topic đó, gửi mỗi cập nhật thành một tin SMS qua HTTP API của một nhà cung cấp, rồi commit offset.

Cách consumer xử lý lỗi hiện tại: đọc tới đâu gửi tới đó, nhanh nhất có thể. Nếu gửi lỗi, nó retry **ngay lập tức, tối đa 3 lần**, rồi ghi log và đi tiếp.

Thứ Sáu vừa rồi:
- Nhà cung cấp SMS **sập 10 phút** (mọi request đều nhận \`503\`). Mọi tin trong 10 phút đó lỗi 3 lần trong vòng một giây rồi bị bỏ. **Khoảng 36.000 khách hàng không bao giờ nhận được tin nhắn.**
- Khi nhà cung cấp hoạt động lại, các consumer lao vào xử lý phần tồn đọng nhanh hơn nhiều so với mức nhà cung cấp cho phép và nhận về hàng loạt \`429 Too Many Requests\`.
- Ngoài ra, mỗi ngày có vài tin mang số điện thoại mà nhà cung cấp từ chối bằng \`400\`. Chúng được retry rồi bị bỏ. Không ai biết đó là những tin nào.

Ràng buộc:
- **Không tin nào được phép mất một cách âm thầm.** Nó hoặc được gửi đi, hoặc được chuyển tới một nơi có người được báo và có thể phát lại nó.
- Nhà cung cấp nhận **120 request mỗi giây** trên tài khoản của bạn. Nếu hơn **2% request** trong một giờ vượt mức đó, họ giới hạn tài khoản trong phần còn lại của giờ.
- **Khi nhà cung cấp hoạt động lại, tin nhắn phải đi trong khoảng 30 giây.** Một tin "tài xế đang ở trước cửa" trễ hơn thế là vô dụng.
- Consumer được **deploy lại vài lần mỗi ngày**.
- Các tin của cùng một đơn có thể tới không theo thứ tự; mỗi tin tự nói rõ nó về việc gì.`,
  },

  question: {
    en: 'How do you change the way the consumer handles a failed send?',
    vi: 'Bạn thay đổi cách consumer xử lý một lần gửi lỗi như thế nào?',
  },

  options: [
    {
      id: 'A',
      text: {
        en: 'Retry in place: back off (1 s, 2 s, 4 s, then every 8 s) and retry the same message until the provider accepts it. Commit the offset only after it succeeds.',
        vi: 'Retry tại chỗ: chờ lùi dần (1 giây, 2 giây, 4 giây, rồi mỗi 8 giây) và retry đúng tin đó cho tới khi nhà cung cấp nhận. Chỉ commit offset sau khi thành công.',
      },
      why: {
        en: 'Nothing is lost in an outage: the offset stays put until the message is delivered, so even a redeploy just reads it again. But a partition is a line, and the consumer only ever works on its head. A message that will never succeed, like a number the provider rejects with `400`, is retried forever, and every text behind it in that partition waits with it. This is head-of-line blocking: one bad message stops a twelfth of all your texts. And when an outage ends, every consumer resumes at full speed at once, running past 120 a second into the `429`s that get the account throttled. Retrying in place suits short, transient errors where order matters. Spring Kafka even lets you combine a few blocking retries with a retry topic for everything longer.',
        vi: 'Không mất gì khi nhà cung cấp sập: offset đứng yên cho tới khi tin được gửi, nên kể cả khi deploy lại thì tin đó cũng chỉ được đọc lại. Nhưng một partition là một hàng đợi, và consumer chỉ xử lý tin ở đầu hàng. Một tin sẽ không bao giờ thành công, như số điện thoại bị nhà cung cấp từ chối bằng `400`, sẽ bị retry mãi mãi, và mọi tin phía sau trong partition đó phải chờ theo. Đây là head-of-line blocking: một tin hỏng chặn một phần mười hai số tin nhắn của bạn. Và khi đợt sập kết thúc, mọi consumer cùng lúc chạy hết tốc lực, vượt 120 mỗi giây và nhận các lỗi `429` khiến tài khoản bị giới hạn. Retry tại chỗ hợp với lỗi ngắn, thoáng qua, khi thứ tự là quan trọng. Spring Kafka còn cho phép kết hợp vài lần retry chặn với một retry topic cho mọi thứ lâu hơn.',
      },
    },
    {
      id: 'B',
      text: {
        en: 'Scale out: grow the topic to 36 partitions and run 36 consumers, so a backlog drains three times faster. Keep the three immediate retries.',
        vi: 'Scale out: tăng topic lên 36 partition và chạy 36 consumer, để phần tồn đọng được xả nhanh gấp ba. Giữ ba lần retry ngay lập tức.',
      },
      why: {
        en: 'Nothing that went wrong was a lack of consumers. The bottleneck is the provider, which accepts 120 requests a second however many consumers call it. During an outage, 36 consumers drop failing messages three times as fast. After it, they burst much further past the limit. The bad phone numbers are still retried three times and dropped. Scaling out helps when the consumer itself is the slow part and whatever it calls has room to spare.',
        vi: 'Không có sự cố nào ở đây là do thiếu consumer. Nút thắt là nhà cung cấp, vốn chỉ nhận 120 request mỗi giây dù có bao nhiêu consumer gọi tới. Khi nhà cung cấp sập, 36 consumer bỏ tin lỗi nhanh gấp ba. Sau đó, chúng dồn dập vượt giới hạn xa hơn nhiều. Các số điện thoại hỏng vẫn bị retry ba lần rồi bỏ. Scale out có ích khi chính consumer là phần chậm và thứ nó gọi tới còn dư sức.',
      },
    },
    {
      id: 'C',
      text: {
        en: 'Retry from memory: when a send fails, put the message in a list inside the consumer, commit the offset, and retry the list every few seconds alongside new messages.',
        vi: 'Retry từ bộ nhớ: khi gửi lỗi, đưa tin vào một danh sách bên trong consumer, commit offset, và retry danh sách đó mỗi vài giây song song với các tin mới.',
      },
      why: {
        en: 'Partitions never block, because the offset moves on. But committing the offset tells Kafka the message is handled, while the only copy is in one process\'s memory. The next deploy or crash, which happens several times a day, wipes the list, and nothing anywhere says those messages existed. A bad number sits in the list being retried forever, and no one is told. After an outage the list and the new messages go out together, past the provider\'s limit. If a message leaves the partition before it is done, it has to go somewhere durable.',
        vi: 'Partition không bao giờ bị chặn, vì offset luôn dời đi. Nhưng commit offset là báo với Kafka rằng tin đã được xử lý, trong khi bản duy nhất của nó nằm trong bộ nhớ của một process. Lần deploy hay crash tiếp theo, chuyện xảy ra vài lần mỗi ngày, xoá sạch danh sách, và không nơi nào ghi lại rằng những tin đó từng tồn tại. Một số điện thoại hỏng nằm trong danh sách và bị retry mãi mãi, mà không ai được báo. Sau một đợt sập, danh sách và các tin mới cùng được gửi đi, vượt giới hạn của nhà cung cấp. Nếu một tin rời partition khi chưa xong, nó phải đi tới một nơi bền vững.',
      },
    },
    {
      id: 'D',
      text: {
        en: 'Cap the consumer group at 100 sends a second. When a send fails with `429` or `5xx`, publish the message to a retry topic that is read again after a delay, then commit. After 5 attempts, or straight away on a `4xx` like an invalid number, publish it to a dead-letter topic that alerts on-call and can be replayed.',
        vi: 'Giới hạn consumer group ở 100 lần gửi mỗi giây. Khi gửi lỗi `429` hoặc `5xx`, publish tin sang một retry topic sẽ được đọc lại sau một khoảng trễ, rồi commit. Sau 5 lần thử, hoặc ngay lập tức khi gặp `4xx` như số điện thoại không hợp lệ, publish nó sang một dead-letter topic có báo cho người trực và có thể phát lại.',
      },
      why: {
        en: 'Each part answers one failure. The cap keeps every send, including the catch-up after an outage, under the provider\'s 120 a second, so there are no `429`s to count against you. The backlog drains at the cap, about 40 a second faster than it arrives. A failed message leaves the partition for the **retry topic**, which is as durable as the main one, so the partition keeps moving and a redeploy loses nothing. The error decides the route: a `503` may work in a few seconds, so it is retried later; a `400` never will, so it goes straight to the **dead-letter queue**. That is where a person looks: it alerts, shows what failed and why, and lets you replay messages once the cause is fixed. Uber built its Kafka reprocessing this way, and Spring Kafka\'s non-blocking retries create the same chain of retry topics and a dead-letter topic. The costs: messages can be delivered out of order (acceptable here), retries mean at-least-once delivery so a customer may rarely get a text twice, and a dead-letter queue nobody owns is just a slower way to lose messages.',
        vi: 'Mỗi phần giải quyết một kiểu lỗi. Giới hạn gửi giữ mọi lần gửi, kể cả lúc bắt kịp sau một đợt sập, dưới mức 120 mỗi giây của nhà cung cấp, nên không có lỗi `429` nào bị tính vào tài khoản. Phần tồn đọng được xả ở mức giới hạn đó, nhanh hơn tốc độ tin tới khoảng 40 tin mỗi giây. Tin lỗi rời partition để sang **retry topic**, vốn bền vững như topic chính, nên partition vẫn tiếp tục chạy và một lần deploy không làm mất gì. Loại lỗi quyết định đường đi: `503` có thể thành công sau vài giây, nên được retry sau; `400` thì không bao giờ, nên đi thẳng vào **dead-letter queue**. Đó là nơi con người nhìn vào: nó báo động, cho thấy tin nào lỗi và vì sao, và cho phép phát lại khi nguyên nhân đã được sửa. Uber xây hệ thống xử lý lại trên Kafka theo cách này, và non-blocking retry của Spring Kafka tạo đúng chuỗi retry topic và dead-letter topic như vậy. Cái giá: tin có thể tới không theo thứ tự (chấp nhận được ở đây), retry nghĩa là giao ít nhất một lần nên thỉnh thoảng khách có thể nhận một tin hai lần, và một dead-letter queue không ai chịu trách nhiệm chỉ là cách mất tin chậm hơn.',
      },
    },
  ],

  answer: 'D',

  takeaway: {
    en: `A queue hands each consumer messages in order and remembers how far it got: the **committed offset**. Everything about error handling is deciding when to move that offset, and where a message goes if it moves on without being done.

- **Retry in place** keeps order and loses nothing, but one message that never succeeds blocks everything behind it (head-of-line blocking).
- **Retry from memory** unblocks the partition, but the offset now lies: a restart loses whatever was in memory.
- **A retry topic** moves the message somewhere durable and lets the partition keep going. Retry transient errors (\`429\`, \`5xx\`, timeouts) after a delay.
- **A dead-letter queue** is the end of the line for messages that will never work (\`4xx\`) or have run out of attempts. It needs an alert, an owner and a way to replay.
- **Rate-limit what you send** to the slowest thing you call, so recovering from an outage does not cause the next one.`,
    vi: `Một queue đưa tin cho từng consumer theo thứ tự và nhớ consumer đã đi tới đâu: **offset đã commit**. Toàn bộ chuyện xử lý lỗi là quyết định khi nào dời offset đó, và tin đi đâu nếu offset dời đi khi tin chưa xong.

- **Retry tại chỗ** giữ thứ tự và không mất gì, nhưng một tin không bao giờ thành công sẽ chặn mọi thứ phía sau (head-of-line blocking).
- **Retry từ bộ nhớ** gỡ chặn partition, nhưng offset giờ nói sai: một lần khởi động lại làm mất mọi thứ trong bộ nhớ.
- **Retry topic** chuyển tin tới một nơi bền vững và để partition tiếp tục chạy. Retry các lỗi thoáng qua (\`429\`, \`5xx\`, timeout) sau một khoảng trễ.
- **Dead-letter queue** là điểm cuối cho những tin sẽ không bao giờ thành công (\`4xx\`) hoặc đã hết lượt thử. Nó cần cảnh báo, người chịu trách nhiệm và cách phát lại.
- **Giới hạn tốc độ gửi** theo thứ chậm nhất mà bạn gọi tới, để việc hồi phục sau một đợt sập không gây ra đợt sập tiếp theo.`,
  },

  sources: [
    { title: 'Uber Engineering: Building Reliable Reprocessing and Dead Letter Queues with Apache Kafka', url: 'https://www.uber.com/blog/reliable-reprocessing/' },
    { title: 'Spring for Apache Kafka documentation: Non-Blocking Retries, How the Pattern Works', url: 'https://docs.spring.io/spring-kafka/reference/retrytopic/how-the-pattern-works.html' },
    { title: 'Amazon SQS documentation: Using dead-letter queues', url: 'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html' },
    { title: 'Confluent: Error Handling Patterns for Apache Kafka Applications', url: 'https://www.confluent.io/blog/error-handling-patterns-in-kafka/' },
  ],

  simulation,
};
