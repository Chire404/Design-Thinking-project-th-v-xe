/* VeloPass Admin Operations Controller & Real Hardware Camera QR Scanner */
(() => {
  const SECTION_TITLES = {
    dashboard: "Tổng Quan Điều Hành & Thống Kê",
    scanner: "Thiết Bị Quét QR Kiểm Soát Vé (Gate Validator)",
    topups: "Đối Soát & Xác Nhận Nạp Tiền",
    users: "Quản Lý Hành Khách & Thẻ Điện Tử",
    transactions: "Sổ Cái Kiểm Soát Giao Dịch",
    support: "Quản Lý Yêu Cầu Hỗ Trợ",
    settings: "Cấu Hình Ngân Hàng & Hệ Thống",
    audit: "Nhật Ký Kiểm Toán Quản Trị (Audit Logs)",
  };

  const ERROR_VI = {
    INVALID_QR: "Mã QR không hợp lệ hoặc không thuộc hệ thống VeloPass.",
    EXPIRED_QR: "Mã QR đã hết hạn hoặc đã được thay bằng mã mới.",
    QR_ALREADY_USED: "Mã QR này đã được sử dụng trước đó (Chống quét trùng).",
    INSUFFICIENT_BALANCE: "Số dư thẻ không đủ 4.000 VNĐ để qua cổng.",
    SUSPENDED_ACCOUNT: "Tài khoản thẻ đang bị Quản trị viên tạm khóa.",
    USER_NOT_FOUND: "Không tìm thấy người dùng liên kết với thẻ này.",
    SERVER_ERROR: "Lỗi kết nối máy chủ xử lý giao dịch.",
  };

  const state = {
    section: "dashboard",
    chartPeriod: "day",
    stream: null,
    scanLoopId: null,
    barcodeDetector: null,
    isVerifyingScan: false,
    resultCooldownTimer: null,
    seenTokens: new Map(), // token -> timestampMs (prevents rescanning same QR held in camera)
    audioCtx: null,
  };

  // --- Navigation ---
  function switchSection(sec) {
    state.section = sec;
    document.querySelectorAll(".adm-section").forEach((el) => {
      el.classList.toggle("active", el.id === `asec-${sec}`);
    });
    document.querySelectorAll(".snav-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.asec === sec);
    });
    document.getElementById("admin-page-title").textContent = SECTION_TITLES[sec] || "Quản Trị";
    document.getElementById("admin-sidebar").classList.remove("open");

    if (sec !== "scanner" && state.stream) {
      stopCamera();
    }
    if (sec === "dashboard") loadDashboard();
    if (sec === "scanner") {
      checkCameraEnvironment();
      loadScannerLogs();
      populateCameraDevices();
    }
    if (sec === "topups") loadAdminTopups();
    if (sec === "users") loadAdminUsers();
    if (sec === "transactions") loadAdminTransactions();
    if (sec === "support") loadAdminSupport();
    if (sec === "settings") loadSettingsAll();
    if (sec === "audit") loadAuditLogs();
  }

  document.querySelectorAll(".snav-btn").forEach((b) => {
    b.onclick = () => switchSection(b.dataset.asec);
  });
  document.querySelectorAll("[data-goto-sec]").forEach((b) => {
    b.onclick = () => switchSection(b.dataset.gotoSec);
  });
  document.getElementById("btn-toggle-sidebar").onclick = () => {
    document.getElementById("admin-sidebar").classList.toggle("open");
  };

  document.querySelectorAll("[data-close-modal]").forEach((el) => {
    el.onclick = () => {
      document.getElementById(el.dataset.closeModal).style.display = "none";
    };
  });

  document.getElementById("btn-admin-logout").onclick = async () => {
    stopCamera();
    await VP.api("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  };

  // --- Web Audio Validator Beep Synthesizer ---
  function playGateSound(isSuccess) {
    if (!document.getElementById("chk-scan-sound").checked) return;
    try {
      const AudioContextCls = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCls) return;
      if (!state.audioCtx) state.audioCtx = new AudioContextCls();
      const ctx = state.audioCtx;
      if (ctx.state === "suspended") ctx.resume();

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (isSuccess) {
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.setValueAtTime(1318.5, now + 0.09);
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
        osc.start(now);
        osc.stop(now + 0.29);
      } else {
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(240, now);
        osc.frequency.setValueAtTime(180, now + 0.16);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
        osc.start(now);
        osc.stop(now + 0.39);
      }
    } catch (_) {}
  }

  // =========================================================================
  // 1. DASHBOARD & CHARTS
  // =========================================================================
  async function loadDashboard() {
    try {
      const data = await VP.api(`/api/admin/dashboard?period=${state.chartPeriod}`);
      const k = data.kpis;
      document.getElementById("kpi-total-users").textContent = k.total_users;
      document.getElementById("kpi-active-cards").textContent = k.active_cards;
      document.getElementById("kpi-suspended-cards").textContent = k.suspended_cards;
      document.getElementById("kpi-total-topup").textContent = k.total_topup_formatted;
      document.getElementById("kpi-total-spent").textContent = k.total_spent_formatted;
      document.getElementById("kpi-success-scans").textContent = k.success_scans;
      document.getElementById("kpi-failed-scans").textContent = k.failed_scans;
      document.getElementById("kpi-pending-topups").textContent = k.pending_topups;

      const bTop = document.getElementById("badge-pending-topups");
      bTop.style.display = k.pending_topups > 0 ? "inline-block" : "none";
      bTop.textContent = k.pending_topups;

      const bSup = document.getElementById("badge-open-support");
      bSup.style.display = k.open_support > 0 ? "inline-block" : "none";
      bSup.textContent = k.open_support;

      renderChart(data.chart);
      renderScanFeed(data.recent_scans, "dashboard-recent-scans");
    } catch (err) {
      VP.toast(err.message, "danger");
    }
  }

  function renderChart(points) {
    const box = document.getElementById("dashboard-chart-box");
    if (!points || !points.length) {
      box.innerHTML = `<p class="adm-muted">Chưa có dữ liệu biểu đồ.</p>`;
      return;
    }
    const maxVal = Math.max(10000, ...points.map((p) => Math.max(p.topup_amount, p.usage_amount)));
    const barsHtml = points
      .map((p) => {
        const topupH = Math.max(3, Math.round((p.topup_amount / maxVal) * 150));
        const usageH = Math.max(3, Math.round((p.usage_amount / maxVal) * 150));
        const shortLabel = p.label.length > 7 ? p.label.slice(5) : p.label;
        return `
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;">
            <div style="height:160px;display:flex;align-items:flex-end;gap:4px;" title="Nạp: ${VP.formatVND(p.topup_amount)} | Quét vé: ${VP.formatVND(p.usage_amount)} (${p.scan_count} lượt)">
              <div style="width:14px;height:${topupH}px;background:#0EA5E9;border-radius:4px 4px 0 0;"></div>
              <div style="width:14px;height:${usageH}px;background:#10B981;border-radius:4px 4px 0 0;"></div>
            </div>
            <span style="font-size:0.73rem;color:#64748B;font-weight:600;">${VP.escapeHtml(shortLabel)}</span>
          </div>
        `;
      })
      .join("");

    box.innerHTML = `
      <div style="display:flex;gap:16px;font-size:0.78rem;margin-bottom:12px;">
        <span><strong style="color:#0EA5E9;">&#9632;</strong> Tiền nạp ví</span>
        <span><strong style="color:#10B981;">&#9632;</strong> Doanh thu quét vé</span>
      </div>
      <div style="display:flex;align-items:flex-end;gap:8px;padding-top:10px;border-bottom:1px solid #E2E8F0;padding-bottom:8px;">
        ${barsHtml}
      </div>
    `;
  }

  document.querySelectorAll(".p-btn").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(".p-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.chartPeriod = btn.dataset.period;
      loadDashboard();
    };
  });
  document.getElementById("btn-refresh-dashboard").onclick = loadDashboard;

  // =========================================================================
  // 2. REAL CAMERA QR SCANNER (BarcodeDetector + jsQR Dual Engine)
  // =========================================================================
  function setScannerPill(text, cls = "") {
    const el = document.getElementById("scanner-status-pill");
    el.textContent = text;
    el.className = `scanner-state-pill ${cls}`;
  }

  function checkCameraEnvironment() {
    const warn = document.getElementById("scanner-https-warning");
    const isSecure =
      window.isSecureContext ||
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1";
    warn.style.display = !isSecure || !navigator.mediaDevices ? "block" : "none";

    if ("BarcodeDetector" in window && !state.barcodeDetector) {
      try {
        state.barcodeDetector = new window.BarcodeDetector({ formats: ["qr_code"] });
      } catch (_) {
        state.barcodeDetector = null;
      }
    }
  }

  async function populateCameraDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === "videoinput");
      const sel = document.getElementById("scanner-camera-select");
      const currentVal = sel.value;
      sel.innerHTML = `<option value="">Tự động ưu tiên Camera sau</option>`;
      cams.forEach((cam, idx) => {
        const opt = document.createElement("option");
        opt.value = cam.deviceId;
        opt.textContent = cam.label || `Camera #${idx + 1}`;
        sel.appendChild(opt);
      });
      if (currentVal) sel.value = currentVal;
    } catch (_) {}
  }

  async function startCamera() {
    checkCameraEnvironment();
    if (!navigator.mediaDevices?.getUserMedia) {
      setScannerPill("TRÌNH DUYỆT KHÔNG HỖ TRỢ CAMERA", "error");
      return VP.toast("Trình duyệt hiện tại không cấp API Camera (hãy dùng HTTPS hoặc localhost).", "danger");
    }

    stopCamera();
    const selectedDeviceId = document.getElementById("scanner-camera-select").value;
    const videoConstraints = selectedDeviceId
      ? { deviceId: { exact: selectedDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } };

    try {
      setScannerPill("ĐANG CẤP QUYỀN CAMERA...", "busy");
      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
      state.stream = stream;

      const video = document.getElementById("scanner-video");
      video.srcObject = stream;
      await video.play();

      document.getElementById("camera-idle-overlay").style.display = "none";
      document.getElementById("btn-start-camera").disabled = true;
      document.getElementById("btn-stop-camera").disabled = false;
      setScannerPill("SẴN SÀNG QUÉT QR", "ready");

      await populateCameraDevices();
      startFrameDecodeLoop();
    } catch (err) {
      setScannerPill("TỪ CHỐI / LỖI CAMERA", "error");
      VP.toast("Không thể mở Camera: Vui lòng cho phép quyền truy cập Camera trên trình duyệt.", "danger");
    }
  }

  function stopCamera() {
    if (state.scanLoopId) {
      clearInterval(state.scanLoopId);
      state.scanLoopId = null;
    }
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    const video = document.getElementById("scanner-video");
    if (video) video.srcObject = null;
    document.getElementById("camera-idle-overlay").style.display = "flex";
    document.getElementById("btn-start-camera").disabled = false;
    document.getElementById("btn-stop-camera").disabled = true;
    setScannerPill("ĐÃ TẮT CAMERA", "");
  }

  function startFrameDecodeLoop() {
    const video = document.getElementById("scanner-video");
    const canvas = document.getElementById("scanner-canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    state.scanLoopId = setInterval(async () => {
      if (!state.stream || state.isVerifyingScan) return;
      if (!document.getElementById("chk-auto-scan").checked) return;
      if (video.readyState < video.HAVE_ENOUGH_DATA) return;

      let rawValue = "";

      // Engine 1: Native GPU BarcodeDetector when supported
      if (state.barcodeDetector) {
        try {
          const codes = await state.barcodeDetector.detect(video);
          if (codes && codes.length > 0 && codes[0].rawValue) {
            rawValue = codes[0].rawValue.trim();
          }
        } catch (_) {}
      }

      // Engine 2: Local jsQR fallback via Canvas ImageData
      if (!rawValue && typeof window.jsQR === "function") {
        const w = Math.min(640, video.videoWidth || 640);
        const h = Math.round(((video.videoHeight || 480) / (video.videoWidth || 640)) * w);
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        const imgData = ctx.getImageData(0, 0, w, h);
        const decoded = window.jsQR(imgData.data, imgData.width, imgData.height, {
          inversionAttempts: "dontInvert",
        });
        if (decoded && decoded.data) {
          rawValue = decoded.data.trim();
        }
      }

      if (rawValue) {
        handleDetectedQRToken(rawValue);
      }
    }, 110);
  }

  function pruneSeenTokens() {
    const cutoff = Date.now() - 12000; // Prevent camera re-triggering identical QR held in frame
    for (const [tok, ts] of state.seenTokens.entries()) {
      if (ts < cutoff) state.seenTokens.delete(tok);
    }
  }

  async function handleDetectedQRToken(qrToken, isManualSubmit = false) {
    if (state.isVerifyingScan) return;
    pruneSeenTokens();

    if (!isManualSubmit && state.seenTokens.has(qrToken)) {
      return; // Ignore same QR still lingering in front of camera lens
    }

    state.isVerifyingScan = true;
    state.seenTokens.set(qrToken, Date.now());
    setScannerPill("ĐANG XÁC THỰC BACKEND...", "busy");

    const idempotencyKey = `GATE-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    try {
      const res = await VP.api("/api/qr/scan", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: { qr_token: qrToken, idempotency_key: idempotencyKey },
      });
      playGateSound(true);
      showScanResultOverlay(true, res);
      loadScannerLogs();
    } catch (err) {
      playGateSound(false);
      showScanResultOverlay(false, err);
      loadScannerLogs();
    }
  }

  function showScanResultOverlay(isSuccess, dataOrErr) {
    if (state.resultCooldownTimer) clearTimeout(state.resultCooldownTimer);

    const overlay = document.getElementById("scan-result-overlay");
    const badge = document.getElementById("res-badge");
    const title = document.getElementById("res-title");
    const details = document.getElementById("res-details");

    overlay.style.display = "flex";
    overlay.className = `scan-result-overlay ${isSuccess ? "is-success" : "is-failed"}`;

    if (isSuccess) {
      setScannerPill("GIAO DỊCH HỢP LỆ (-4.000 VNĐ)", "ready");
      badge.textContent = "SCAN SUCCESS";
      title.textContent = "MỞ CỔNG — TRỪ VÉ THÀNH CÔNG";
      details.innerHTML = `
        <div class="res-row"><span>HÀNH KHÁCH:</span><strong>${VP.escapeHtml(dataOrErr.user_name)}</strong></div>
        <div class="res-row"><span>MÃ THẺ:</span><strong class="mono">${VP.escapeHtml(dataOrErr.card_number)}</strong></div>
        <div class="res-row"><span>SỐ TIỀN TRỪ:</span><strong>${VP.escapeHtml(dataOrErr.amount_formatted)}</strong></div>
        <div class="res-row"><span>SỐ DƯ TRƯỚC:</span><span>${VP.escapeHtml(dataOrErr.balance_before_formatted)}</span></div>
        <div class="res-row"><span>SỐ DƯ SAU:</span><strong>${VP.escapeHtml(dataOrErr.balance_after_formatted)}</strong></div>
        <div class="res-row"><span>MÃ GIAO DỊCH:</span><span class="mono">${VP.escapeHtml(dataOrErr.transaction_code)}</span></div>
        <div class="res-row"><span>THỜI GIAN:</span><span>${VP.formatDateTime(dataOrErr.scanned_at)}</span></div>
        <div class="res-row"><span>TRẠNG THÁI:</span><strong>SUCCESS</strong></div>
      `;
    } else {
      const code = dataOrErr.code || "SERVER_ERROR";
      setScannerPill(`TỪ CHỐI: ${code}`, "error");
      badge.textContent = `SCAN FAILED • ${code}`;
      title.textContent = "KHÔNG HỢP LỆ — TỪ CHỐI QUA CỔNG";
      const msgVi = dataOrErr.message || ERROR_VI[code] || "Không thể xác thực mã QR.";
      details.innerHTML = `
        <div style="font-size:0.95rem;font-weight:700;margin-bottom:6px;">Lý do từ chối:</div>
        <div>${VP.escapeHtml(msgVi)}</div>
      `;
    }

    state.resultCooldownTimer = setTimeout(() => {
      dismissScanOverlay();
    }, 3000);
  }

  function dismissScanOverlay() {
    if (state.resultCooldownTimer) clearTimeout(state.resultCooldownTimer);
    document.getElementById("scan-result-overlay").style.display = "none";
    state.isVerifyingScan = false;
    if (state.stream) {
      setScannerPill("SẴN SÀNG QUÉT TIẾP", "ready");
    } else {
      setScannerPill("CHƯA BẬT CAMERA", "");
    }
  }

  document.getElementById("btn-start-camera").onclick = startCamera;
  document.getElementById("btn-stop-camera").onclick = stopCamera;
  document.getElementById("btn-scan-next").onclick = dismissScanOverlay;
  document.getElementById("scanner-camera-select").onchange = () => {
    if (state.stream) startCamera();
  };

  document.getElementById("form-manual-scan").addEventListener("submit", async (e) => {
    e.preventDefault();
    const inp = document.getElementById("manual-qr-input");
    const tok = inp.value.trim();
    if (!tok) return;
    inp.value = "";
    await handleDetectedQRToken(tok, true);
  });

  async function loadScannerLogs() {
    try {
      const data = await VP.api("/api/admin/scan-logs");
      renderScanFeed(data.scan_logs, "scanner-log-list");
    } catch (_) {}
  }
  document.getElementById("btn-refresh-scans").onclick = loadScannerLogs;

  function renderScanFeed(items, targetId) {
    const el = document.getElementById(targetId);
    if (!el) return;
    if (!items || !items.length) {
      el.innerHTML = `<div class="adm-muted" style="padding:14px;text-align:center;">Chưa có dữ liệu quét QR.</div>`;
      return;
    }
    el.innerHTML = items
      .map(
        (s) => `
        <div class="feed-item">
          <div>
            <strong>${VP.escapeHtml(s.user_name || "Không xác định")}</strong>
            ${s.card_number ? `<span class="mono">(${VP.escapeHtml(s.card_number)})</span>` : ""}
            <div class="adm-muted">${VP.escapeHtml(s.message)} &bull; ${VP.formatDateTime(s.created_at)}</div>
          </div>
          <div style="text-align:right;">
            <span class="badge badge--${s.status}">${s.status}</span>
            ${s.status === "SUCCESS" ? `<div style="font-weight:800;color:#DC2626;margin-top:3px;">${VP.escapeHtml(s.amount_formatted)}</div>` : ""}
          </div>
        </div>`
      )
      .join("");
  }

  // =========================================================================
  // 3. ADMIN TOP-UP VERIFICATION
  // =========================================================================
  async function loadAdminTopups() {
    const status = document.getElementById("filter-topup-status").value;
    const user = document.getElementById("filter-topup-query").value.trim();
    try {
      const data = await VP.api(
        `/api/admin/topups?status=${encodeURIComponent(status)}&user=${encodeURIComponent(user)}`
      );
      const tbody = document.getElementById("tbody-admin-topups");
      if (!data.topups.length) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#64748B;">Không có giao dịch nạp tiền phù hợp.</td></tr>`;
        return;
      }
      tbody.innerHTML = data.topups
        .map((t) => {
          const canAct = ["PENDING", "PROCESSING"].includes(t.status);
          return `
            <tr>
              <td class="mono">${VP.escapeHtml(t.transaction_code)}</td>
              <td><strong>${VP.escapeHtml(t.user_name)}</strong><br/><span class="adm-muted">@${VP.escapeHtml(t.username)}</span></td>
              <td><strong style="color:#059669;">${VP.escapeHtml(t.amount_formatted)}</strong></td>
              <td class="mono">${VP.escapeHtml(t.transfer_content)}</td>
              <td><span class="badge badge--${t.status}">${t.status}</span></td>
              <td class="mono">${VP.escapeHtml(t.bank_reference || "—")}</td>
              <td>${VP.formatDateTime(t.created_at)}</td>
              <td>
                ${
                  canAct
                    ? `<button class="adm-btn adm-btn--emerald adm-btn--sm" data-confirm-topup="${t.id}" data-code="${VP.escapeHtml(t.transaction_code)}" data-amt="${VP.escapeHtml(t.amount_formatted)}" data-content="${VP.escapeHtml(t.transfer_content)}">Duyệt</button>
                       <button class="adm-btn adm-btn--danger adm-btn--sm" data-reject-topup="${t.id}">Từ chối</button>`
                    : `<span class="adm-muted">Đã đóng</span>`
                }
              </td>
            </tr>`;
        })
        .join("");

      tbody.querySelectorAll("[data-confirm-topup]").forEach((btn) => {
        btn.onclick = () => {
          document.getElementById("confirm-topup-id").value = btn.dataset.confirmTopup;
          document.getElementById("confirm-bank-ref").value = "";
          document.getElementById("confirm-topup-summary").textContent =
            `Đơn ${btn.dataset.code} • Số tiền ${btn.dataset.amt} • Nội dung CK: ${btn.dataset.content}`;
          document.getElementById("modal-confirm-topup").style.display = "flex";
        };
      });

      tbody.querySelectorAll("[data-reject-topup]").forEach((btn) => {
        btn.onclick = async () => {
          const reason = prompt("Nhập lý do từ chối đơn nạp tiền:", "Chưa nhận được khoản chuyển trên sao kê");
          if (reason === null) return;
          try {
            await VP.api(`/api/admin/topups/${btn.dataset.rejectTopup}/reject`, {
              method: "POST",
              body: { reason },
            });
            VP.toast("Đã từ chối đơn nạp tiền.", "warning");
            loadAdminTopups();
            loadDashboard();
          } catch (err) {
            VP.toast(err.message, "danger");
          }
        };
      });
    } catch (err) {
      VP.toast(err.message, "danger");
    }
  }

  document.getElementById("btn-filter-topups").onclick = loadAdminTopups;

  document.getElementById("form-confirm-topup").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("confirm-topup-id").value;
    try {
      await VP.api(`/api/admin/topups/${id}/confirm`, {
        method: "POST",
        body: {
          bank_reference: document.getElementById("confirm-bank-ref").value.trim(),
          note: document.getElementById("confirm-note").value.trim(),
        },
      });
      document.getElementById("modal-confirm-topup").style.display = "none";
      VP.toast("Đã xác nhận nạp tiền và kích hoạt số dư ví thành công!", "success");
      loadAdminTopups();
      loadDashboard();
    } catch (err) {
      VP.toast(err.message, "danger");
    }
  });

  // =========================================================================
  // 4. USER MANAGEMENT
  // =========================================================================
  async function loadAdminUsers() {
    const search = document.getElementById("filter-user-search").value.trim();
    const status = document.getElementById("filter-user-status").value;
    try {
      const data = await VP.api(
        `/api/admin/users?search=${encodeURIComponent(search)}&status=${encodeURIComponent(status)}`
      );
      const tbody = document.getElementById("tbody-admin-users");
      if (!data.users.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#64748B;">Không tìm thấy hành khách nào.</td></tr>`;
        return;
      }
      tbody.innerHTML = data.users
        .map(
          (u) => `
          <tr>
            <td>#${u.id}</td>
            <td><strong>${VP.escapeHtml(u.full_name)}</strong><br/><span class="adm-muted">${VP.escapeHtml(u.email)} (@${VP.escapeHtml(u.username)})</span></td>
            <td class="mono">${VP.escapeHtml(u.card_number)}</td>
            <td><strong>${VP.escapeHtml(u.balance_formatted)}</strong></td>
            <td><span class="badge badge--${u.card_status}">${u.card_status}</span></td>
            <td>${u.qr_enabled ? '<span class="badge badge--ACTIVE">Hoạt động</span>' : '<span class="badge badge--FAILED">Vô hiệu</span>'}</td>
            <td>
              <button class="adm-btn adm-btn--outline adm-btn--sm" data-view-user="${u.id}">Chi tiết</button>
              ${
                u.status === "ACTIVE"
                  ? `<button class="adm-btn adm-btn--danger adm-btn--sm" data-suspend-user="${u.id}">Khóa</button>`
                  : `<button class="adm-btn adm-btn--emerald adm-btn--sm" data-activate-user="${u.id}">Mở khóa</button>`
              }
            </td>
          </tr>`
        )
        .join("");

      tbody.querySelectorAll("[data-view-user]").forEach((b) => {
        b.onclick = () => openUserDetailModal(Number(b.dataset.viewUser));
      });
      tbody.querySelectorAll("[data-suspend-user]").forEach((b) => {
        b.onclick = async () => {
          const reason = prompt("Lý do tạm khóa tài khoản này:", "Vi phạm quy định sử dụng thẻ");
          if (reason === null) return;
          try {
            await VP.api(`/api/admin/users/${b.dataset.suspendUser}/suspend`, { method: "POST", body: { reason } });
            VP.toast("Đã tạm khóa tài khoản và thu hồi mã QR.", "warning");
            loadAdminUsers();
          } catch (err) {
            VP.toast(err.message, "danger");
          }
        };
      });
      tbody.querySelectorAll("[data-activate-user]").forEach((b) => {
        b.onclick = async () => {
          try {
            await VP.api(`/api/admin/users/${b.dataset.activateUser}/activate`, {
              method: "POST",
              body: { reason: "Mở khóa bởi Quản trị viên" },
            });
            VP.toast("Đã mở khóa tài khoản hành khách.", "success");
            loadAdminUsers();
          } catch (err) {
            VP.toast(err.message, "danger");
          }
        };
      });
    } catch (err) {
      VP.toast(err.message, "danger");
    }
  }

  document.getElementById("btn-search-users").onclick = loadAdminUsers;

  async function openUserDetailModal(userId) {
    try {
      const d = await VP.api(`/api/admin/users/${userId}`);
      document.getElementById("ud-title").textContent = `Hồ Sơ: ${d.user.full_name} (@${d.user.username})`;
      document.getElementById("ud-body").innerHTML = `
        <div class="adm-grid-2" style="margin-bottom:14px;">
          <div style="padding:12px;background:#F8FAFC;border-radius:12px;">
            <div><strong>Mã thẻ:</strong> <span class="mono">${VP.escapeHtml(d.card.card_number)}</span></div>
            <div><strong>Trạng thái thẻ:</strong> <span class="badge badge--${d.card.status}">${d.card.status}</span></div>
            <div><strong>Email:</strong> ${VP.escapeHtml(d.user.email)}</div>
            <div><strong>SĐT:</strong> ${VP.escapeHtml(d.user.phone || "—")}</div>
          </div>
          <div style="padding:12px;background:#F0FDFA;border-radius:12px;">
            <div><strong>Số dư hiện tại:</strong> <strong style="color:#0284C7;font-size:1.1rem;">${VP.escapeHtml(d.wallet.balance_formatted)}</strong></div>
            <div><strong>Tổng đã nạp:</strong> ${VP.escapeHtml(d.wallet.total_topup_formatted)}</div>
            <div><strong>Tổng đã đi:</strong> ${VP.escapeHtml(d.wallet.total_spent_formatted)}</div>
            <div><strong>QR khả dụng:</strong> ${d.card.qr_enabled ? "Có" : "Không"}</div>
          </div>
        </div>

        <form id="form-ud-adjust" style="padding:12px;border:1px solid #E2E8F0;border-radius:12px;margin-bottom:14px;">
          <strong>Điều chỉnh số dư đối soát (Có lưu Sổ cái &amp; Audit Log)</strong>
          <div class="filter-bar" style="margin-top:8px;">
            <select id="adj-dir" class="adm-select">
              <option value="CREDIT">Cộng điều chỉnh (+)</option>
              <option value="DEBIT">Trừ điều chỉnh (-)</option>
            </select>
            <input type="number" id="adj-amt" class="adm-input" placeholder="Số tiền VNĐ" min="1000" required />
            <input type="text" id="adj-reason" class="adm-input" placeholder="Lý do điều chỉnh (>= 5 ký tự)" required minlength="5" />
            <button type="submit" class="adm-btn adm-btn--primary adm-btn--sm">Thực hiện</button>
          </div>
        </form>

        <div class="adm-grid-2">
          <div>
            <strong>Lịch sử nạp tiền (${d.topups.length})</strong>
            <div class="compact-feed" style="max-height:190px;margin-top:6px;">
              ${
                d.topups.length
                  ? d.topups.map((t) => `<div class="feed-item"><span class="mono">${VP.escapeHtml(t.transaction_code)}</span><span>+${VP.escapeHtml(t.amount_formatted)} (${t.status})</span></div>`).join("")
                  : `<div class="adm-muted">Chưa có giao dịch nạp.</div>`
              }
            </div>
          </div>
          <div>
            <strong>Lịch sử quét vé (${d.usages.length})</strong>
            <div class="compact-feed" style="max-height:190px;margin-top:6px;">
              ${
                d.usages.length
                  ? d.usages.map((u) => `<div class="feed-item"><span class="mono">${VP.escapeHtml(u.transaction_code)}</span><span>${VP.escapeHtml(u.amount_formatted)} &rarr; ${VP.escapeHtml(u.balance_after_formatted)}</span></div>`).join("")
                  : `<div class="adm-muted">Chưa có lượt quét.</div>`
              }
            </div>
          </div>
        </div>
      `;

      document.getElementById("form-ud-adjust").onsubmit = async (ev) => {
        ev.preventDefault();
        try {
          await VP.api(`/api/admin/users/${userId}/adjust-balance`, {
            method: "POST",
            body: {
              direction: document.getElementById("adj-dir").value,
              amount: Number(document.getElementById("adj-amt").value),
              reason: document.getElementById("adj-reason").value.trim(),
            },
          });
          VP.toast("Đã điều chỉnh số dư và ghi nhận Audit Log.", "success");
          openUserDetailModal(userId);
          loadAdminUsers();
        } catch (err) {
          VP.toast(err.message, "danger");
        }
      };

      document.getElementById("modal-user-detail").style.display = "flex";
    } catch (err) {
      VP.toast(err.message, "danger");
    }
  }

  // =========================================================================
  // 5. TRANSACTIONS LEDGER
  // =========================================================================
  async function loadAdminTransactions() {
    const q = new URLSearchParams({
      user: document.getElementById("tx-f-user").value.trim(),
      type: document.getElementById("tx-f-type").value,
      date_from: document.getElementById("tx-f-from").value,
      date_to: document.getElementById("tx-f-to").value,
      min_amount: document.getElementById("tx-f-min").value,
    });
    try {
      const data = await VP.api(`/api/admin/transactions?${q.toString()}`);
      const tbody = document.getElementById("tbody-admin-tx");
      if (!data.transactions.length) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#64748B;">Không có giao dịch khớp bộ lọc.</td></tr>`;
        return;
      }
      tbody.innerHTML = data.transactions
        .map(
          (t) => `
          <tr>
            <td class="mono">${VP.escapeHtml(t.transaction_code)}</td>
            <td><strong>${VP.escapeHtml(t.user_name)}</strong> (@${VP.escapeHtml(t.username)})</td>
            <td><span class="badge badge--PROCESSING">${VP.escapeHtml(t.transaction_type)}</span></td>
            <td><strong style="color:${t.signed_amount_formatted.startsWith("-") ? "#DC2626" : "#059669"};">${VP.escapeHtml(t.signed_amount_formatted)}</strong></td>
            <td>${VP.escapeHtml(t.balance_before_formatted)}</td>
            <td><strong>${VP.escapeHtml(t.balance_after_formatted)}</strong></td>
            <td>${VP.escapeHtml(t.admin_name || "Hệ thống")}</td>
            <td>${VP.formatDateTime(t.created_at)}</td>
          </tr>`
        )
        .join("");
    } catch (err) {
      VP.toast(err.message, "danger");
    }
  }
  document.getElementById("btn-filter-tx").onclick = loadAdminTransactions;

  // =========================================================================
  // 6. SUPPORT TICKETS
  // =========================================================================
  async function loadAdminSupport() {
    try {
      const data = await VP.api("/api/admin/support");
      const tbody = document.getElementById("tbody-admin-support");
      if (!data.support_requests.length) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#64748B;">Chưa có yêu cầu hỗ trợ nào.</td></tr>`;
        return;
      }
      tbody.innerHTML = data.support_requests
        .map(
          (s) => `
          <tr>
            <td>#${s.id}</td>
            <td><strong>${VP.escapeHtml(s.user_name)}</strong><br/><span class="mono">${VP.escapeHtml(s.card_number || "")}</span></td>
            <td><strong>${VP.escapeHtml(s.subject)}</strong><div class="adm-muted">${VP.escapeHtml(s.message)}</div></td>
            <td><span class="badge badge--${s.status === "RESOLVED" ? "SUCCESS" : "PENDING"}">${s.status}</span></td>
            <td>
              ${
                s.status !== "RESOLVED"
                  ? `<button class="adm-btn adm-btn--emerald adm-btn--sm" data-resolve-sup="${s.id}">Phản hồi &amp; Đóng</button>`
                  : `<span class="adm-muted">${VP.escapeHtml(s.admin_note || "Đã giải quyết")}</span>`
              }
            </td>
          </tr>`
        )
        .join("");

      tbody.querySelectorAll("[data-resolve-sup]").forEach((b) => {
        b.onclick = async () => {
          const note = prompt("Nhập nội dung phản hồi cho hành khách:", "Đã kiểm tra và xử lý hoàn tất.");
          if (note === null) return;
          await VP.api(`/api/admin/support/${b.dataset.resolveSup}/resolve`, {
            method: "POST",
            body: { status: "RESOLVED", admin_note: note },
          });
          VP.toast("Đã phản hồi yêu cầu hỗ trợ.", "success");
          loadAdminSupport();
          loadDashboard();
        };
      });
    } catch (err) {
      VP.toast(err.message, "danger");
    }
  }
  document.getElementById("btn-refresh-support").onclick = loadAdminSupport;

  // =========================================================================
  // 7. BANK & SYSTEM SETTINGS
  // =========================================================================
  async function loadSettingsAll() {
    try {
      const [bank, sys] = await Promise.all([
        VP.api("/api/admin/settings/bank"),
        VP.api("/api/admin/settings/system"),
      ]);

      document.getElementById("bs-bank-name").value = bank.bank_name || "";
      document.getElementById("bs-short-name").value = bank.bank_short_name || "";
      document.getElementById("bs-bank-bin").value = bank.bank_bin || "";
      document.getElementById("bs-acc-num").value = bank.account_number || "";
      document.getElementById("bs-acc-holder").value = bank.account_holder || "";
      document.getElementById("bs-prefix").value = bank.transfer_prefix || "VP";
      document.getElementById("bs-active").value = String(bank.is_active ?? 1);
      document.getElementById("bs-qr-url").value = bank.bank_qr_url || "";
      document.getElementById("bs-instructions").value = bank.payment_instructions || "";

      const s = sys.settings;
      document.getElementById("ss-fare").value = s.fare_amount;
      document.getElementById("ss-ttl").value = s.qr_ttl_seconds;
      document.getElementById("ss-low-bal").value = s.low_balance_threshold;
      document.getElementById("ss-notif").value = String(s.notifications_enabled ?? 1);

      const wb = document.getElementById("webhook-status-box");
      if (sys.webhook_configured) {
        wb.className = "adm-alert adm-alert--success";
        wb.innerHTML = `<strong>Webhook Ngân Hàng (${VP.escapeHtml(sys.webhook_provider)}):</strong> Đang kích hoạt xác thực chữ ký HMAC-SHA256 tự động.`;
      } else {
        wb.className = "adm-alert adm-alert--info";
        wb.innerHTML = `<strong>Chế độ đối soát hiện tại:</strong> Chưa cấu hình <code>PAYMENT_WEBHOOK_SECRET</code> trong <code>.env</code> — Hệ thống vận hành ở chế độ <strong>Admin xác nhận thủ công dựa trên sao kê thực tế</strong>.`;
      }

      const fhEl = document.getElementById("fare-history-list");
      fhEl.innerHTML = sys.fare_history.length
        ? sys.fare_history
            .map(
              (h) => `
              <div class="feed-item">
                <div><strong>${VP.escapeHtml(h.old_fare_formatted)} &rarr; ${VP.escapeHtml(h.new_fare_formatted)}</strong><div class="adm-muted">${VP.escapeHtml(h.reason)}</div></div>
                <span class="adm-muted">${VP.formatDateTime(h.created_at)}</span>
              </div>`
            )
            .join("")
        : `<div class="adm-muted">Đang áp dụng giá mặc định 4.000 VNĐ/lượt.</div>`;
    } catch (err) {
      VP.toast(err.message, "danger");
    }
  }

  document.getElementById("form-bank-settings").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await VP.api("/api/admin/settings/bank", {
        method: "PUT",
        body: {
          bank_name: document.getElementById("bs-bank-name").value.trim(),
          bank_short_name: document.getElementById("bs-short-name").value.trim(),
          bank_bin: document.getElementById("bs-bank-bin").value.trim(),
          account_number: document.getElementById("bs-acc-num").value.trim(),
          account_holder: document.getElementById("bs-acc-holder").value.trim(),
          transfer_prefix: document.getElementById("bs-prefix").value.trim(),
          is_active: Number(document.getElementById("bs-active").value),
          bank_qr_url: document.getElementById("bs-qr-url").value.trim(),
          payment_instructions: document.getElementById("bs-instructions").value.trim(),
        },
      });
      VP.toast("Đã lưu thông tin ngân hàng nhận tiền.", "success");
      loadSettingsAll();
    } catch (err) {
      VP.toast(err.message, "danger");
    }
  });

  document.getElementById("form-sys-settings").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await VP.api("/api/admin/settings/system", {
        method: "PUT",
        body: {
          fare_amount: Number(document.getElementById("ss-fare").value),
          qr_ttl_seconds: Number(document.getElementById("ss-ttl").value),
          low_balance_threshold: Number(document.getElementById("ss-low-bal").value),
          notifications_enabled: Number(document.getElementById("ss-notif").value),
          fare_change_reason: document.getElementById("ss-reason").value.trim(),
        },
      });
      VP.toast("Đã lưu cấu hình vận hành hệ thống.", "success");
      loadSettingsAll();
    } catch (err) {
      VP.toast(err.message, "danger");
    }
  });

  // =========================================================================
  // 8. AUDIT LOGS
  // =========================================================================
  async function loadAuditLogs() {
    try {
      const data = await VP.api("/api/admin/audit-logs?limit=150");
      const tbody = document.getElementById("tbody-audit-logs");
      if (!data.audit_logs.length) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#64748B;">Chưa có nhật ký quản trị.</td></tr>`;
        return;
      }
      tbody.innerHTML = data.audit_logs
        .map(
          (a) => `
          <tr>
            <td>#${a.id}</td>
            <td><strong>${VP.escapeHtml(a.admin_name)}</strong> (@${VP.escapeHtml(a.admin_username)})</td>
            <td><span class="badge badge--PROCESSING">${VP.escapeHtml(a.action)}</span></td>
            <td class="mono">${VP.escapeHtml(a.target_type)} #${VP.escapeHtml(a.target_id)}</td>
            <td class="mono" style="max-width:300px;overflow-wrap:anywhere;">${VP.escapeHtml(a.metadata_json)}</td>
            <td class="mono">${VP.escapeHtml(a.ip_address)}</td>
            <td>${VP.formatDateTime(a.created_at)}</td>
          </tr>`
        )
        .join("");
    } catch (err) {
      VP.toast(err.message, "danger");
    }
  }
  document.getElementById("btn-refresh-audit").onclick = loadAuditLogs;

  // --- Admin Real-time SSE Listener ---
  if (window.EventSource) {
    const es = new EventSource("/api/admin/stream");
    es.addEventListener("topup_created", () => {
      if (state.section === "dashboard") loadDashboard();
      if (state.section === "topups") loadAdminTopups();
    });
    es.addEventListener("topup_processing", () => {
      VP.toast("Có hành khách vừa báo đã chuyển khoản nạp tiền!", "info");
      if (state.section === "dashboard") loadDashboard();
      if (state.section === "topups") loadAdminTopups();
    });
    es.addEventListener("scan_completed", () => {
      if (state.section === "dashboard") loadDashboard();
    });
  }

  // Initial load
  loadDashboard();
})();
