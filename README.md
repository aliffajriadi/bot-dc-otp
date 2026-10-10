# Bot Discord Jual OTP

Bot Discord untuk menjual nomor OTP. Nomor dibeli real-time dari **OTPCepat**, saldo user dikelola sistem lain lewat **API Saldo** (Rupiah). Detail kebutuhan ada di [PRD.md](PRD.md).

## Setup

```bash
pnpm install
cp .env.example .env        # isi semua nilai
pnpm db:generate
pnpm db:migrate             # prisma migrate deploy (MySQL harus sudah jalan)
pnpm register               # daftarkan /admin (juga otomatis dijalankan saat bot start)
pnpm dev                    # atau: pnpm build && pnpm start
pnpm test
```

Di Discord Developer Portal aktifkan **Message Content Intent** (dibutuhkan untuk `!show panel`).
Izin bot di channel panel: View Channel, Send Messages, Embed Links, Manage Messages (untuk menghapus pesan `!show panel` dan panel lama).

Setelah bot online, owner mengetik `!show panel` di channel tujuan. Hanya ada satu panel aktif; menjalankannya lagi menghapus panel lama.

## Environment

| Variabel | Keterangan |
|---|---|
| `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID` | Kredensial bot; guild ID mempercepat register command |
| `OWNER_DISCORD_IDS` | ID owner, dipisah koma |
| `PANEL_PREFIX` | Prefix command panel (default `!`) |
| `DATABASE_URL` | MySQL |
| `LOG_CHANNEL_ID` | Opsional. Channel log pembelian + notifikasi owner; kalau kosong/gagal, notifikasi lewat DM owner. `/admin logs #channel` menimpa nilai ini |
| `SALDO_API_BASE_URL`, `SALDO_API_KEY` | API saldo (header `x-api-key`) |
| `OTP_API_BASE_URL`, `OTP_API_KEY` | API OTPCepat |
| `ORDER_TIMEOUT_MINUTES` | Default batas tunggu SMS (bisa diubah `/admin timeout`, 1-20) |
| `POLL_INTERVAL_SECONDS` | Interval worker polling |
| `DEFAULT_MARKUP_RP` | Markup global awal |
| `MAX_ACTIVE_ORDERS` | Maksimal order aktif per user (default 3) |

API key tidak pernah dilog (URL dimasking, `x-api-key` di-redact). `.env` ada di `.gitignore`.

## Struktur

- `src/clients/` — client + parser API saldo dan OTPCepat
- `src/services/` — harga/markup, katalog (cache 60 dtk), `OrderService` (beli, cancel, refund), `PollWorker`, `recoverOrders`
- `src/discord/` — panel, alur beli (dropdown), command `/admin`, notifikasi
- `tests/` — unit test dengan mock kedua API dan store in-memory

## Asumsi yang diambil

- Saldo hanya Rupiah; `amountWl` selalu 0.
- **Format respons OTPCepat** belum ada dokumentasi pasti di PRD, jadi parser dibuat longgar (nama field alternatif, `status` `"true"`/`true`, price string/number, array polos atau dibungkus `data`). **Uji dengan API asli** dan sesuaikan `src/clients/otp.ts` bila ada field yang tidak terbaca.
- **Idempotensi refund**: `refundedAt` diklaim lewat update kondisional *sebelum* memanggil API saldo. Jika API saldo gagal, klaim dilepas dan order jadi `REFUND_FAILED` lalu di-retry dengan backoff (maks 8x, setelahnya `NEEDS_REVIEW` + notifikasi owner). Jika bot mati tepat setelah klaim, saat start order ditandai `NEEDS_REVIEW` (tidak diketahui sudah/belum ter-refund; cek log saldo manual). Ini memilih "tidak refund ganda" di kasus ambigu. API saldo tidak punya idempotency key, jadi timeout saat refund yang ternyata sukses bisa menyebabkan refund ganda saat retry (kasus langka; deskripsi saldo memuat ID order untuk audit).
- **Potong saldo**: penolakan jelas dari API → `FAILED`. Timeout/jaringan (tidak pasti terpotong) → `NEEDS_REVIEW` tanpa refund otomatis.
- **`get_order` gagal** (termasuk timeout): user di-refund dan tidak ada retry otomatis. Kalau provider sebenarnya membuat order saat timeout, owner bisa rugi satu nomor; tetap mengutamakan saldo user.
- Cancel: cek status → `set_status=2` → verifikasi `Cancel` → refund. Tidak terverifikasi → `CANCEL_PENDING`, retry 5x lalu `NEEDS_REVIEW`.
- Setelah SMS diterima, order `COMPLETED` dan `set_status=4` (Finish) dipanggil best-effort.
- **Tombol Kirim Ulang SMS (status 3) tidak dibuat**: semantik `set_status=3` di OTPCepat belum terverifikasi, jadi dihapus dari DM. DM hanya punya tombol Batalkan.
- **Tombol Batalkan** di DM baru aktif setelah `CANCEL_MIN_MINUTES` (default 5) sejak order dibuat; sebelum itu nonaktif dan permintaan ditolak di server. Worker merender ulang DM sekali saat tombol aktif. Timeout otomatis tetap berlaku.
- **Salin Nomor**: Discord tidak punya tombol salin. Nomor ditampilkan dalam code block (tekan-tahan untuk menyalin).
- Pesan DM diedit di tempat (`channelId`/`messageId` disimpan di order, tidak bergantung token interaksi); kode OTP dikirim sebagai satu pesan baru agar user mendapat notifikasi.
- Satu panel aktif per bot (kunci `panel_channel_id`/`panel_message_id` di `Setting`), bot diasumsikan dipakai di satu server.
- Penambahan di luar model acuan: kolom `operatorName`, `dmChannelId`, `dmMessageId`, `cancelAttempts`, `refundAttempts`, `nextRetryAt` di `Order`, tabel `OrderEvent` untuk audit, dan env `LOG_CHANNEL_ID`, `MAX_ACTIVE_ORDERS`.
- Search service memakai modal (maks 20 karakter) dan state dibawa lewat `customId`, sehingga alur tetap jalan setelah restart.

## Command owner

`/admin markup-global`, `markup-service`, `markup-list`, `timeout`, `order`, `orders [status]`, `logs <jenis> [#channel]`, `logs-list`, `refund <orderId>` (khusus NEEDS_REVIEW), `stats`, `maintenance`, `panel-text` (form edit judul/isi/footer/warna/banner; `reset:true` untuk bawaan). Semua ephemeral dan dicek terhadap `OWNER_DISCORD_IDS` di handler.

## Uji manual (langkah 9 PRD)

Belum dijalankan di server Discord sungguhan. Sebelum produksi, uji di server dev dengan harga kecil: sukses, timeout, provider gagal, dan matikan paksa bot di tengah order.
