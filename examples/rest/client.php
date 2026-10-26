<?php
/**
 * A small client for the OLX Lebanon SDK REST service, using PHP's curl extension.
 *
 * Start the service first (`npx olx-lb serve`), then:
 *   OLX_SDK_API_KEY=<SERVER_API_KEY from .env> php examples/rest/client.php
 *
 * Under IIS or Apache, getenv() often can't see system environment variables: pass the key
 * from your app's config instead.
 */

declare(strict_types=1);

final class OlxSdkException extends RuntimeException
{
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly array $details = [],
        public readonly ?string $requestId = null,
    ) {
        parent::__construct("$status $errorCode: $message");
    }
}

final class OlxSdkClient
{
    private string $base;

    public function __construct(private string $apiKey, string $baseUrl = 'http://127.0.0.1:8787', private int $timeout = 10)
    {
        $this->base = rtrim($baseUrl, '/') . '/v1';
    }

    /** Queues a create or update for a product. Returns the job id. */
    public function syncProduct(string $productId, array $listing, bool $force = false): string
    {
        return $this->call('PUT', $this->product($productId) . ($force ? '?force=true' : ''), $listing)['jobId'];
    }

    /** Queues removal of the product's ad. Returns the job id. */
    public function removeProduct(string $productId): string
    {
        return $this->call('DELETE', $this->product($productId))['jobId'];
    }

    public function job(string $jobId): array
    {
        return $this->call('GET', '/jobs/' . rawurlencode($jobId));
    }

    /** Polls until the job has finished. Writes are paced about a minute apart. */
    public function wait(string $jobId, int $pollSeconds = 5, int $timeoutSeconds = 900): array
    {
        $deadline = time() + $timeoutSeconds;
        while (true) {
            $job = $this->job($jobId);
            if (!in_array($job['status'], ['queued', 'running'], true)) {
                return $job;
            }
            if (time() > $deadline) {
                throw new RuntimeException("Job $jobId is still {$job['status']}");
            }
            sleep($pollSeconds);
        }
    }

    /** The stored product ↔ ad link, or null. */
    public function listing(string $productId): ?array
    {
        try {
            return $this->call('GET', $this->product($productId));
        } catch (OlxSdkException $e) {
            if ($e->errorCode === 'not_found') {
                return null;
            }
            throw $e;
        }
    }

    private function product(string $productId): string
    {
        return '/products/' . rawurlencode($productId) . '/listing';
    }

    private function call(string $method, string $path, ?array $body = null): array
    {
        $headers = ['X-Api-Key: ' . $this->apiKey];
        $ch = curl_init($this->base . $path);
        $options = [
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => $this->timeout,
        ];
        if ($body !== null) {
            $headers[] = 'Content-Type: application/json';
            // An empty `attributes` array encodes as [] and is accepted as "no attributes".
            $options[CURLOPT_POSTFIELDS] = json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
        }
        $options[CURLOPT_HTTPHEADER] = $headers;
        curl_setopt_array($ch, $options);

        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError = curl_error($ch);
        curl_close($ch);
        if ($raw === false) {
            throw new RuntimeException("OLX SDK service unreachable: $curlError");
        }

        $data = json_decode((string) $raw, true) ?? [];
        if ($status >= 400) {
            $e = $data['error'] ?? [];
            throw new OlxSdkException($status, $e['code'] ?? 'unknown', $e['message'] ?? (string) $raw, $e['details'] ?? [], $e['requestId'] ?? null);
        }
        return $data;
    }
}

if (PHP_SAPI === 'cli' && realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    $client = new OlxSdkClient((string) getenv('OLX_SDK_API_KEY'), getenv('OLX_SDK_URL') ?: 'http://127.0.0.1:8787');
    try {
        $jobId = $client->syncProduct('SKU-1042', [
            'title'       => 'Dell Latitude 5440',
            'description' => '16 GB RAM, 512 GB SSD, 1 year warranty',
            'price'       => '899.00', // a decimal string, as SQL decimals often arrive, is fine
            'categoryId'  => '175',
            'locationId'  => '47',
            'attributes'  => ['make' => '3', 'type' => '1', 'new_used' => '1'],
            'images'      => [['url' => 'https://shop.example.com/images/dell-5440.jpg']],
        ]);
    } catch (OlxSdkException $e) {
        // invalid_listing: $e->details['issues'] says which field; queue_full: retry later
        fwrite(STDERR, $e->getMessage() . ' ' . json_encode($e->details) . PHP_EOL);
        exit(1);
    }

    $job = $client->wait($jobId);
    if ($job['status'] === 'succeeded') {
        $record = $job['result']['record'];
        echo "{$job['result']['action']} {$record['adId']} {$record['status']}" . PHP_EOL;
    } else {
        // olx_rejected: $job['error']['details']['olxErrors'] names the field OLX refused
        echo 'Failed: ' . json_encode($job['error'] ?? null) . PHP_EOL;
    }
}
