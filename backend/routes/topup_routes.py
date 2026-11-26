"""Top-up creation, inspection, user transfer notification, and signed Payment Webhook APIs."""

from __future__ import annotations

from flask import Blueprint, current_app, g, request

from backend.routes import api_success, rate_limit, require_auth
from backend.services.topup_service import (
    cancel_user_topup,
    create_topup_order,
    get_topup_detail,
    get_user_topups,
    process_payment_webhook,
    user_report_transferred,
)

topup_bp = Blueprint("topup_api", __name__)


@topup_bp.post("/api/topups")
@require_auth
@rate_limit("create_topup", max_requests=15, window_seconds=60)
def create_topup():
    body = request.get_json(silent=True) or {}
    order = create_topup_order(
        user_id=int(g.auth["user_id"]),
        raw_amount=body.get("amount"),
    )
    return api_success(order, "Đã tạo đơn nạp tiền và mã QR chuyển khoản.", 201)


@topup_bp.get("/api/topups")
@require_auth
def list_topups():
    items = get_user_topups(int(g.auth["user_id"]))
    return api_success({"topups": items})


@topup_bp.get("/api/topups/<int:topup_id>")
@require_auth
def get_topup(topup_id: int):
    is_admin = g.auth.get("role") in ("ADMIN", "SUPER_ADMIN")
    detail = get_topup_detail(int(g.auth["user_id"]), topup_id, is_admin=is_admin)
    return api_success(detail)


@topup_bp.post("/api/topups/<int:topup_id>/report-transferred")
@require_auth
def report_transferred(topup_id: int):
    body = request.get_json(silent=True) or {}
    updated = user_report_transferred(
        user_id=int(g.auth["user_id"]),
        topup_id=topup_id,
        note=body.get("note", ""),
    )
    return api_success(
        updated,
        "Đã ghi nhận thông báo chuyển khoản. Hệ thống/Admin sẽ đối soát sao kê ngân hàng trước khi cộng tiền.",
    )


@topup_bp.post("/api/topups/<int:topup_id>/cancel")
@require_auth
def cancel_topup(topup_id: int):
    updated = cancel_user_topup(int(g.auth["user_id"]), topup_id)
    return api_success(updated, "Đã hủy yêu cầu nạp tiền.")


@topup_bp.post("/api/payment/webhook")
@rate_limit("payment_webhook", max_requests=60, window_seconds=60)
def payment_webhook():
    raw_body = request.get_data(cache=True)
    signature = (
        request.headers.get("X-Webhook-Signature")
        or request.headers.get("X-Signature")
        or request.headers.get("Authorization", "")
    )
    payload = request.get_json(silent=True) or {}
    result = process_payment_webhook(
        raw_body=raw_body,
        signature_header=signature,
        payload=payload,
        webhook_secret=str(current_app.config.get("PAYMENT_WEBHOOK_SECRET", "")),
        provider_name=str(current_app.config.get("PAYMENT_WEBHOOK_PROVIDER", "SEPAY_COMPATIBLE")),
        qr_hmac_secret=str(current_app.config["QR_HMAC_SECRET"]),
    )
    return api_success(result, "Xử lý webhook thanh toán hoàn tất.", 200)
