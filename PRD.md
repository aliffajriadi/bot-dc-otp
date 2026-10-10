# PRD: Bot Discord Jual OTP

Dokumen ini adalah brief untuk AI agent (Claude Code). Kerjakan sesuai urutan di bagian "Tahapan Implementasi". Kalau ada hal yang ambigu, pilih opsi paling aman (utamakan saldo user tidak hilang) dan catat asumsinya di README.

## 1. Ringkasan

Bot Discord untuk menjual nomor OTP (SMS verifikasi). Bot tidak menyimpan stok sendiri: nomor dibeli real-time dari provider **OTPCepat** (reseller). Saldo user dikelola oleh sistem lain lewat **API Saldo** (saldo dalam Rupiah). Owner bisa menambah markup harga di atas harga provider.

Alur singkat: user pilih negara, operator, dan service lewat Discord. Bot memotong saldo, memesan nomor, mengirim nomor ke DM, lalu menunggu SMS. Kalau SMS tidak masuk dalam batas waktu, order dibatalkan dan saldo dikembalikan otomatis.

## 2. Tujuan dan Non-Tujuan

**Tujuan**
- User bisa beli OTP sepenuhnya lewat Discord.
- Saldo user aman: tidak pernah terpotong tanpa hasil, tidak pernah ter-refund dua kali.
- Owner bisa atur markup harga tanpa ubah kode.
- Order yang sedang menunggu tetap aman kalau bot restart atau crash.

**Non-Tujuan**
- Topup saldo (ditangani sistem saldo yang sudah ada, bukan bot ini).
- Dashboard web.
- Pembayaran langsung (QRIS dan sejenisnya).
- Saldo dalam WL: **bot hanya memakai saldo Rupiah** (`amountRp`). Field `balance` (WL) diabaikan, `amountWl` selalu `0`.

## 3. Stack (keputusan agent, bisa diubah)

- Node.js 20+, TypeScript, **discord.js v14**
- **pnpm**
- MySQL + **Prisma**
- Library HTTP: `undici` atau `axios`; validasi response dengan `zod`
- Logger: `pino`
- Konfigurasi lewat `.env` (jangan hardcode key)

## 4. Environment Variables

```
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=            # untuk register command cepat saat dev
OWNER_DISCORD_IDS=           # daftar ID owner, dipisah koma
PANEL_PREFIX=!               # prefix untuk command !show panel
DATABASE_URL=

SALDO_API_BASE_URL=          # base URL API saldo
SALDO_API_KEY=               # dikirim sebagai header x-api-key

OTP_API_BASE_URL=https://otpcepat.org/api/handler_api.php
OTP_API_KEY=

ORDER_TIMEOUT_MINUTES=5      # default, bisa diubah owner lewat command
POLL_INTERVAL_SECONDS=5
DEFAULT_MARKUP_RP=1000
```

Catatan keamanan:
- Key OTPCepat dikirim lewat query string (`api_key=...`). **Jangan pernah log URL lengkap.** Buat helper yang memasking `api_key` sebelum logging.
- Jangan commit `.env`. Sediakan `.env.example`.

## 5. Integrasi API Eksternal

### 5.1 API Saldo (sistem lain)

Semua request wajib header `x-api-key: <SALDO_API_KEY>`.

**Cek user**: `GET /api/users/check?discordId=...`
Field penting di `data`: `discordId`, `balanceRupiah`, `isBlacklisted`, `role`. Abaikan `balance` (WL).

**Ubah saldo**: `POST /api/users/balance`
```json
{
  "discordId": "123456789012345678",
  "action": "deduct",
  "amountWl": 0,
  "amountRp": 5000,
  "description": "Beli OTP #<orderId> (<service>)"
}
```
- `action`: `deduct` untuk potong, `add` untuk refund. Jangan pakai `set`.
- Selalu isi `description` dengan ID order internal, supaya log saldo bisa dilacak.
- Kalau user tidak ditemukan atau API error, anggap pembelian gagal dan jangan lanjut ke provider.

### 5.2 API OTPCepat (provider)

Base: `OTP_API_BASE_URL`, semua method GET dengan query `api_key` dan `action`.

| Aksi | action | Parameter tambahan |
|---|---|---|
| Daftar negara | `getCountries` | - |
| Daftar operator | `getOperators` | `country_id` |
| Daftar service + harga | `getServices` | `country_id` |
| Buat order | `get_order` | `operator_id`, `service_id`, `country_id` |
| Cek status | `get_status` | `order_id` |
| Ubah status | `set_status` | `order_id`, `status` (2=Cancel, 3=Resend SMS, 4=Finish) |

Catatan penting soal respons:
- Field `status` tidak konsisten: kadang string `"true"`/`"false"`, kadang boolean `true`. Parser harus menerima keduanya.
- Pesan error ada di `msg`. Daftar error yang diketahui: `You don't have Access!`, `BAD ACTION`, `NO BALANCE`, `INVALID OPERATOR`, `INVALID SERVICE ID`, `WRONG SERVICE ID`, `WRONG OPERATOR ID`, `WRONG COUNTRY ID`, `INVALID ORDER ID`, `WRONG ORDER ID`, `WRONG STATUS`, `INVALID STATUS`.
- `price` dari provider kadang string, kadang number. Normalisasi ke integer Rupiah.
- Status order dari `get_status`: `Waiting SMS`, `Recieved` (perhatikan ejaan dokumentasi, bisa juga `Received`; cocokkan tanpa peduli huruf besar-kecil dan terima kedua ejaan), `Cancel`, `Done`. Status tak dikenal harus dilog dan diperlakukan sebagai "belum final".
- `NO BALANCE` artinya saldo akun provider (milik owner) habis. Ini bukan salah user: refund user dan kirim notifikasi ke owner.

Cache: hasil `getCountries`, `getOperators`, dan `getServices` boleh di-cache di memori selama 60 detik supaya tidak menembak provider di setiap klik.

## 6. Harga dan Markup

- Harga jual = harga provider + markup.
- Markup berupa nominal Rupiah tetap (contoh +1000), disimpan di database.
- Dua level:
  1. **Markup global** (default dari `DEFAULT_MARKUP_RP`, bisa diubah owner).
  2. **Override per service** (opsional). Kalau ada, override menggantikan markup global untuk service tersebut.
- Harga final yang dilihat user dihitung ulang saat menampilkan menu, dan **dihitung ulang lagi saat konfirmasi pembelian**. Kalau harga berubah antara menu dan konfirmasi, tampilkan harga baru dan minta user konfirmasi ulang.
- Semua kalkulasi pakai integer Rupiah, tanpa float.

## 7. Alur Pembelian (Detail)

1. User klik tombol **Beli OTP** di panel (lihat bagian 10A). Tidak ada slash command untuk beli: semua lewat tombol dan dropdown.
2. Bot membalas dengan pesan **ephemeral** (hanya terlihat user itu) yang berisi dropdown dan tombol, bertahap:
   - **Langkah 1, negara**: dropdown (`StringSelectMenu`) berisi daftar negara dari `getCountries`.
   - **Langkah 2, operator**: pesan yang sama di-update jadi dropdown operator dari `getOperators`. Sediakan tombol **Kembali**.
   - **Langkah 3, service**: dropdown service dari `getServices`, tiap opsi menampilkan nama service dan **harga final** (harga provider + markup). Tombol **Kembali** tetap ada.
   - Dropdown Discord maksimal 25 opsi. Kalau opsi lebih dari 25, bagi per halaman dan tambahkan tombol **Sebelumnya / Berikutnya**. Untuk service yang banyak, tambahkan tombol **Cari** yang membuka modal input teks untuk filter nama service.
3. Setelah service dipilih, bot menampilkan ringkasan (negara, operator, service, harga final, saldo user) dengan tombol **Konfirmasi** (hijau) dan **Batal** (merah).

Catatan implementasi alur tombol:
- State pilihan (countryId, operatorId, serviceId, halaman) dibawa lewat `customId` (maksimal 100 karakter, pakai format ringkas seperti `otp:svc:<countryId>:<operatorId>:<page>`), bukan disimpan di memori, supaya aman kalau bot restart.
- Hanya user yang membuka alur itu yang boleh menekan komponennya. Karena pesannya ephemeral ini otomatis terpenuhi, tapi tetap validasi `interaction.user.id` kalau ada informasi user di `customId`.
- Token interaksi berlaku 15 menit. Kalau user terlalu lama dan interaksi kedaluwarsa, minta dia klik **Beli OTP** lagi di panel.
4. Saat Konfirmasi, bot melakukan **pre-check** secara berurutan:
   - User tidak blacklisted dan saldo Rupiah cukup (lewat `users/check`).
   - **DM bisa dikirim**: bot kirim pesan "Memproses pesananmu..." ke DM. Kalau gagal (DM ditutup), batalkan sebelum potong saldo dan beri tahu user di channel untuk membuka DM.
   - User tidak punya order aktif melebihi batas (default maksimal 3 order aktif bersamaan).
5. Buat record `Order` di database dengan status `PENDING_PAYMENT`.
6. **Potong saldo** (`deduct`). Kalau gagal, status `FAILED`, selesai (belum ada yang perlu di-refund). Kalau berhasil, status `PAID` dan simpan penanda `paidAmount`.
7. Panggil `get_order` ke provider.
   - Gagal (termasuk `NO BALANCE`, error jaringan, atau error lain): lakukan **refund** (bagian 8), status `FAILED_REFUNDED`, beri tahu user. Untuk `NO BALANCE` juga notifikasi owner.
   - Sukses: simpan `providerOrderId`, `phoneNumber`, status `WAITING_SMS`, simpan `expiresAt = now + timeout`.
8. Kirim ke DM: nomor telepon, service, sisa waktu tunggu, dan tombol **Batalkan**, **Kirim Ulang SMS** (resend, status 3), serta **Salin Nomor** jika memungkinkan.
9. **Polling** `get_status` setiap `POLL_INTERVAL_SECONDS` (per order aktif, jangan sampai menumpuk; pakai satu worker loop yang memproses semua order aktif, bukan satu timer per order).
   - Status Received/ada `sms`: simpan teks SMS, kirim kode OTP ke DM (tampilkan teks SMS apa adanya, boleh bantu ekstrak kode angka), status `COMPLETED`, lalu panggil `set_status` = 4 (Finish).
   - Waktu habis (`now >= expiresAt`) tanpa SMS: lakukan **alur cancel + refund** (bagian 8).
10. Edit pesan DM yang sama untuk update status (hindari spam pesan baru).

## 8. Aturan Refund dan Cancel (PENTING)

Ini bagian paling kritis. Prinsip: **user tidak boleh rugi, tapi owner juga tidak boleh dirugikan dengan refund ganda atau refund untuk SMS yang sudah diterima.**

Alur cancel (dipicu timeout atau tombol Batalkan):
1. Panggil `get_status` dulu. Kalau sudah Received, **jangan cancel dan jangan refund**: proses sebagai sukses.
2. Kalau masih Waiting SMS, panggil `set_status` = 2 (Cancel).
3. Setelah itu panggil `get_status` lagi untuk memverifikasi status `Cancel`.
   - Terverifikasi Cancel: lanjut refund.
   - Cancel gagal atau status tidak jelas: jangan refund dulu. Tandai `CANCEL_PENDING`, coba ulang di siklus berikutnya (maksimal beberapa kali). Kalau tetap gagal, tandai `NEEDS_REVIEW` dan notifikasi owner.
4. Refund: panggil `balance` dengan `action: "add"`, `amountRp = paidAmount`.

Jaminan idempotensi:
- Tabel `Order` punya kolom `refundedAt`. Refund hanya boleh dijalankan kalau `refundedAt` masih null, dan harus dilakukan dalam transaksi/lock yang menandai refund **sebelum** memanggil API saldo (atau gunakan update kondisional `WHERE refundedAt IS NULL` dan cek jumlah baris yang berubah).
- Kalau panggilan refund ke API saldo gagal, status jadi `REFUND_FAILED` dan **di-retry otomatis** dengan backoff. Jangan hilang diam-diam.
- Satu order hanya boleh mengalami satu dari: `COMPLETED` atau `REFUNDED`, tidak boleh keduanya.
- Konfirmasi dua klik (double click tombol) tidak boleh membuat dua order: kunci per user selama proses konfirmasi.

Tombol **Resend SMS** (status 3): hanya valid saat status `WAITING_SMS`. Resend tidak memperpanjang `expiresAt` kecuali diputuskan lain; catat di README.

## 9. Pemulihan Setelah Restart

Saat bot start, jalankan `recoverOrders()`:
- Ambil semua order berstatus `PENDING_PAYMENT`, `PAID`, `WAITING_SMS`, `CANCEL_PENDING`, `REFUND_FAILED`.
- `PAID` tanpa `providerOrderId`: kemungkinan crash di antara potong saldo dan pesan ke provider. Karena tidak ada nomor yang dibeli, **refund**.
- `WAITING_SMS`: lanjutkan polling. Kalau `expiresAt` sudah lewat, jalankan alur cancel + refund.
- `PENDING_PAYMENT`: potong saldo belum tentu terjadi. Cek log saldo kalau memungkinkan, kalau tidak, tandai `NEEDS_REVIEW` dan notifikasi owner. Jangan refund tanpa bukti sudah dipotong.
- `REFUND_FAILED` dan `CANCEL_PENDING`: lanjutkan retry.

## 10. Fitur Owner

Semua command owner hanya bisa dijalankan oleh ID di `OWNER_DISCORD_IDS` (cek di handler, bukan hanya permission Discord). Respons command owner bersifat ephemeral.

### 10A. Panel Pembelian (`!show panel`)

Owner membuat panel permanen di channel yang dia pilih dengan mengetik `!show panel` (prefix `!` bisa diubah lewat env `PANEL_PREFIX`).

Perilaku:
- Hanya ID di `OWNER_DISCORD_IDS` yang bisa memakai command ini. Dari non-owner: abaikan diam-diam (jangan balas).
- Bot menghapus pesan `!show panel` milik owner (kalau punya izin), lalu mengirim **satu pesan panel** berisi embed dan tombol:
  - **Beli OTP** (utama, mulai alur bagian 7)
  - **Cek Saldo** (balasan ephemeral berisi saldo Rupiah dari API saldo)
  - **Riwayat** (balasan ephemeral berisi 10 order terakhir user itu)
- Embed berisi judul toko, penjelasan singkat cara beli, info timeout (otomatis ikut nilai setting) dan kebijakan refund. Teks embed bisa diubah owner lewat `/admin panel-text`.
- `channelId` dan `messageId` panel disimpan di tabel `Setting`. Kalau owner menjalankan `!show panel` lagi, panel lama dihapus atau di-edit supaya hanya ada satu panel aktif per server.
- Panel **harus tetap berfungsi setelah bot restart**: `customId` tombol statis (contoh `panel:buy`, `panel:balance`, `panel:history`) dan ditangani global di `interactionCreate`, bukan lewat collector yang hilang saat restart.
- Saat mode maintenance aktif, tombol **Beli OTP** membalas ephemeral "Pembelian sedang ditutup sementara", tombol lain tetap jalan.
- Wajib aktifkan **Message Content Intent** di Discord Developer Portal dan di kode (`GatewayIntentBits.MessageContent`), karena command `!` adalah prefix command.

### 10B. Command Slash Owner

- `/admin markup-global <nominal>`: ubah markup global.
- `/admin markup-service <service_id> <nominal>`: override markup satu service. `nominal` kosong atau `reset` untuk menghapus override.
- `/admin markup-list`: tampilkan markup global dan semua override.
- `/admin timeout <menit>`: ubah batas tunggu SMS (rentang wajar, misal 1 sampai 20 menit).
- `/admin order <orderId>`: lihat detail order (user, service, nomor, status, waktu, refund).
- `/admin orders [status]`: daftar order terbaru, bisa filter status (terutama `NEEDS_REVIEW` dan `REFUND_FAILED`).
- `/admin stats`: ringkasan sederhana (jumlah order hari ini, sukses, refund, estimasi margin).
- `/admin maintenance <on|off>`: matikan pembelian baru sementara (order aktif tetap diproses sampai selesai).

Notifikasi otomatis ke owner (kirim DM atau ke channel log yang dikonfigurasi): `NO BALANCE` dari provider, order `NEEDS_REVIEW`, refund yang gagal berulang kali, API eksternal tidak merespons.

## 11. Fitur User

Semua fitur user diakses lewat tombol di panel (bagian 10A), bukan slash command:
- Tombol **Beli OTP**: alur pembelian dengan dropdown (bagian 7).
- Tombol **Cek Saldo**: tampilkan saldo Rupiah (dari API saldo), ephemeral.
- Tombol **Riwayat**: 10 order terakhir milik user sendiri (service, harga, status, waktu), ephemeral.
- Tombol di DM: Batalkan, Kirim Ulang SMS.

Pesan ke user memakai bahasa Indonesia yang singkat dan jelas, tanpa jargon teknis. Contoh nada: "Nomor kamu sudah siap. Tunggu SMS-nya maksimal 5 menit, kalau tidak masuk saldo otomatis dikembalikan."

## 12. Model Data (Prisma, acuan)

```prisma
model Order {
  id              String   @id @default(cuid())
  discordId       String
  countryId       String
  countryName     String
  operatorId      String
  serviceId       String
  serviceName     String
  providerPrice   Int      // harga dari OTPCepat
  markup          Int      // markup yang berlaku saat order
  paidAmount      Int      // providerPrice + markup
  providerOrderId String?  @unique
  phoneNumber     String?
  smsText         String?  @db.Text
  status          OrderStatus
  expiresAt       DateTime?
  refundedAt      DateTime?
  failReason      String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([discordId])
  @@index([status])
}

enum OrderStatus {
  PENDING_PAYMENT
  PAID
  WAITING_SMS
  COMPLETED
  CANCEL_PENDING
  REFUNDED
  REFUND_FAILED
  FAILED
  FAILED_REFUNDED
  NEEDS_REVIEW
}

model Setting {
  key   String @id        // contoh: markup_global, order_timeout_minutes, maintenance
  value String
}

model ServiceMarkup {
  serviceId String @id
  markup    Int
}
```

Simpan snapshot `providerPrice` dan `markup` di tiap order supaya riwayat dan refund selalu konsisten walau harga berubah belakangan.

## 13. Edge Case yang Harus Ditangani

- DM user tertutup (dicek sebelum potong saldo).
- Provider down atau timeout: set timeout request (misal 10 detik) dan retry terbatas untuk request baca. **Jangan retry otomatis `get_order`** tanpa memastikan order sebelumnya tidak terbentuk (risiko beli ganda).
- Provider mengembalikan nomor tapi `get_status` terus error: tetap hitung ke timeout, lalu alur cancel + refund.
- Beberapa klik cepat atau interaksi duplikat dari Discord.
- User blacklisted di tengah proses: order yang sudah berjalan tetap diselesaikan, order baru ditolak.
- Interaksi Discord kedaluwarsa (token interaksi 15 menit): untuk update DM jangan bergantung pada token interaksi, simpan `channelId` dan `messageId` lalu edit lewat API biasa.
- Rate limit Discord dan rate limit provider: antrekan request, jangan polling terlalu rapat.
- Harga atau service hilang dari provider saat konfirmasi: batalkan sebelum potong saldo.
- Panel dihapus manual oleh admin server: tombol hilang, owner cukup jalankan `!show panel` lagi. Simpan referensi lama dan tangani error "Unknown Message" tanpa crash.
- User menekan tombol panel di tengah proses beli yang lain: boleh, tiap klik membuka alur ephemeral baru, batasan maksimal order aktif tetap berlaku di tahap konfirmasi.
- Bot kehilangan izin (kirim pesan, hapus pesan, embed) di channel panel: log error jelas dan beri tahu owner.

## 14. Non-Functional

- Setiap panggilan ke API saldo dan provider dicatat di log (tanpa API key), dengan `orderId` sebagai korelasi.
- Semua perubahan status order dicatat (kolom atau tabel `OrderEvent`) untuk audit.
- Test otomatis untuk: perhitungan harga + markup, parser respons provider (variasi `"true"`/`true`), idempotensi refund, dan recovery order. Gunakan mock untuk kedua API eksternal.
- README berisi cara setup, daftar env, cara register command, dan asumsi yang diambil.

## 15. Tahapan Implementasi (urutan kerja untuk agent)

1. Setup proyek (pnpm, TypeScript, discord.js, Prisma, MySQL, pino), `.env.example`, struktur folder.
2. Client untuk API Saldo dan API OTPCepat, lengkap dengan parser dan masking key, plus unit test dengan mock.
3. Skema Prisma + migrasi, modul setting dan markup, kalkulasi harga.
4. Panel: command `!show panel` (khusus owner) yang mengirim embed + tombol, handler global tombol, lalu tombol **Cek Saldo** dan **Riwayat** (paling sederhana, untuk memvalidasi integrasi dan panel).
5. Alur tombol **Beli OTP**: dropdown negara, operator, service (pagination + cari), konfirmasi, potong saldo, `get_order`, sampai pesan nomor ke DM.
6. Worker polling: terima SMS, selesai, timeout, cancel, refund (lengkap dengan idempotensi).
7. Recovery saat restart.
8. Command owner dan notifikasi owner.
9. Test end-to-end dengan mock, lalu uji manual di server Discord dev dengan harga kecil.

## 16. Kriteria Selesai

- Skenario sukses: user beli, nomor muncul di DM, SMS masuk, kode OTP tampil, saldo terpotong tepat sekali.
- Skenario timeout: SMS tidak masuk, order dibatalkan di provider, saldo kembali tepat sekali.
- Skenario provider gagal setelah saldo terpotong: saldo otomatis kembali.
- Bot dimatikan paksa di tengah order, lalu dinyalakan lagi: order tidak hilang dan saldo tidak ganda atau hilang.
- Owner bisa ubah markup dan perubahan langsung berlaku di harga yang tampil.
- Tidak ada API key di log maupun di repo.

## 17. Asumsi yang Diambil (boleh diubah)

- Saldo hanya Rupiah, WL diabaikan.
- Timeout default 5 menit, bisa diubah owner.
- Markup nominal tetap, global + override per service (persen tidak dibuat).
- Stack: Node.js, TypeScript, discord.js, MySQL, Prisma, pnpm.
- Maksimal 3 order aktif per user bersamaan.
- Pembelian lewat panel tombol dan dropdown (bukan slash command), dibuat owner dengan `!show panel`. Slash command hanya untuk `/admin ...`.