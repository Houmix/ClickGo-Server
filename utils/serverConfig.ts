import AsyncStorage from '@react-native-async-storage/async-storage';

const SERVER_KEY     = 'server_screen_url';
const RESTAURANT_KEY = 'server_screen_restaurant_id';
const DISCOVER_PATH  = '/api/sync/discover/';
const PORT           = 8000;
const SCAN_TIMEOUT   = 2500;

let _url          = '';
let _restaurantId = '';

export function getPosUrl()       { return _url; }
export function getRestaurantId() { return _restaurantId; }

export async function loadSavedUrl(): Promise<{ url: string; restaurantId: string } | null> {
    const savedUrl = await AsyncStorage.getItem(SERVER_KEY).catch(() => null);
    const savedRid = await AsyncStorage.getItem(RESTAURANT_KEY).catch(() => null);
    if (savedUrl) {
        _url = savedUrl;
        if (savedRid) _restaurantId = savedRid;
        return { url: savedUrl, restaurantId: savedRid || '' };
    }
    return null;
}

export async function saveUrl(url: string, restaurantId = '') {
    _url = url;
    _restaurantId = restaurantId;
    await AsyncStorage.setItem(SERVER_KEY, url);
    if (restaurantId) await AsyncStorage.setItem(RESTAURANT_KEY, restaurantId);
}

export async function clearUrl() {
    _url = '';
    _restaurantId = '';
    await AsyncStorage.multiRemove([SERVER_KEY, RESTAURANT_KEY]);
}

/** Teste si une URL complète (http://x.x.x.x:8000) répond comme un serveur caisse */
export async function testUrl(url: string): Promise<{ url: string; restaurantId: string } | null> {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), SCAN_TIMEOUT);
        const res = await fetch(`${url}${DISCOVER_PATH}`, { signal: ctrl.signal });
        clearTimeout(t);
        if (res.ok) {
            const data = await res.json();
            if (data.server === 'caisse') {
                return { url, restaurantId: data.restaurant_id?.toString() || '' };
            }
        }
    } catch {}
    return null;
}

/** Teste une IP brute ou une URL complète */
export async function testIp(ip: string): Promise<{ url: string; restaurantId: string } | null> {
    // Si c'est déjà une URL complète, tester directement
    if (ip.startsWith('http')) return testUrl(ip);
    return testUrl(`http://${ip}:${PORT}`);
}

export async function scanNetwork(
    onProgress?: (scanned: number, total: number) => void
): Promise<{ url: string; restaurantId: string } | null> {
    const subnets  = ['192.168.1', '192.168.0', '192.168.2', '10.0.0', '10.0.1', '192.168.100'];
    const priority = [1, 2, 100, 101, 50, 200, 254, 10, 20, 30, 40];

    const ips: string[] = ['127.0.0.1'];
    for (const subnet of subnets) {
        for (const last of priority) ips.push(`${subnet}.${last}`);
        for (let i = 1; i <= 254; i++) {
            if (!priority.includes(i)) ips.push(`${subnet}.${i}`);
        }
    }

    const total = ips.length;
    let scanned = 0;
    const BATCH = 30;

    for (let i = 0; i < ips.length; i += BATCH) {
        const results = await Promise.all(ips.slice(i, i + BATCH).map(testIp));
        scanned += Math.min(BATCH, ips.length - i);
        onProgress?.(scanned, total);
        const found = results.find(r => r !== null);
        if (found) return found;
    }
    return null;
}
