/* The categories a scenario can belong to, in the order the list's filter shows them.
   Every scenario sets `category` to one of these ids (tests/scenarios.test.js checks it).
   Labels are content, so they are { en, vi } like the scenarios. */
export default [
  { id: 'caching', label: { en: 'Caching', vi: 'Caching' } },
  { id: 'database', label: { en: 'Database', vi: 'Database' } },
  { id: 'queue', label: { en: 'Queue & streaming', vi: 'Queue & streaming' } },
  { id: 'microservices', label: { en: 'Microservices', vi: 'Microservices' } },
  { id: 'networking', label: { en: 'Networking & APIs', vi: 'Mạng & API' } },
  { id: 'reliability', label: { en: 'Reliability', vi: 'Độ tin cậy' } },
  { id: 'scalability', label: { en: 'Scalability', vi: 'Khả năng mở rộng' } },
  { id: 'security', label: { en: 'Security', vi: 'Bảo mật' } },
];
