-- Chạy sau khi URL bên dưới đã hoạt động. Đổi URL nếu Render cấp tên khác.
-- Dùng lại tên job hiện có để chuyển đích mà không tạo lịch trùng.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'love-space-keepalive',
  '*/5 * * * *',
  $job$select net.http_get(
    url := 'https://love-space.onrender.com/health/keepalive',
    timeout_milliseconds := 60000
  );$job$
);
