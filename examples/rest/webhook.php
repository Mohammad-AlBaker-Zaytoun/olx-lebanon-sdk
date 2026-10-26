<?php
/**
 * Receives the REST service's job notifications (set WEBHOOK_URL and WEBHOOK_SECRET in its .env).
 * OLX_WEBHOOK_SECRET here must hold the same value as WEBHOOK_SECRET there.
 */

declare(strict_types=1);

/** Returns the job when the request is genuine and fresh, or null. */
function olxVerifyWebhook(string $secret, string $body, string $timestamp, string $signature, int $toleranceSeconds = 300): ?array
{
    if (strlen($secret) < 16) {
        // Never verify with an empty or missing secret: hash_hmac would then accept forged requests.
        throw new RuntimeException('The webhook secret is not configured');
    }
    if (!ctype_digit($timestamp) || abs(time() - (int) $timestamp) > $toleranceSeconds) {
        return null;
    }
    $expected = 'sha256=' . hash_hmac('sha256', "$timestamp.$body", $secret);
    if (!hash_equals($expected, $signature)) {
        return null;
    }
    $job = json_decode($body, true);
    return is_array($job) ? $job : null;
}

if (PHP_SAPI !== 'cli') {
    $job = olxVerifyWebhook(
        (string) getenv('OLX_WEBHOOK_SECRET'),
        (string) file_get_contents('php://input'),
        $_SERVER['HTTP_X_OLX_SDK_TIMESTAMP'] ?? '',
        $_SERVER['HTTP_X_OLX_SDK_SIGNATURE'] ?? '',
    );
    if ($job === null) {
        http_response_code(401);
        exit;
    }

    // $job: id, type (upsert | remove), productId, status (succeeded | failed | cancelled), result, error
    if ($job['status'] === 'succeeded' && $job['type'] === 'upsert') {
        $adId = $job['result']['record']['adId'];   // save it next to your product
        $adStatus = $job['result']['record']['status']; // active, pending_review, limited…
    } elseif ($job['status'] === 'cancelled') {
        // The service stopped before this job ran: send the request again.
    } elseif ($job['status'] === 'failed') {
        $code = $job['error']['code']; // e.g. invalid_listing, olx_rejected, reconcile_required
    }
    http_response_code(204);
}
