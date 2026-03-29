import { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, StatusBar,
  TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { loadSavedUrl, saveUrl, clearUrl, scanNetwork, testIp, getPosUrl, getRestaurantId } from './utils/serverConfig';

// ── Types ─────────────────────────────────────────────────────────────────────
type AppScreen = 'scanning' | 'service';

interface OrderItem {
  menu_name: string;
  quantity: number;
  solo: boolean;
  extra: boolean;
  composition: { step_name: string; option_name: string; option_price: number }[];
}
interface ServiceOrder {
  order_id: number;
  kds_status: string;
  delivery_type: string;
  take_away: boolean;
  customer_identifier: string;
  created_at: string;
  total_price: number;
  items: OrderItem[];
}

const DELIVERY_LABEL: Record<string, string> = {
  sur_place: 'Sur place', emporter: 'Emporter', livraison: 'Livraison',
};
const DELIVERY_COLOR: Record<string, string> = {
  sur_place: '#64748b', emporter: '#f59e0b', livraison: '#f97316',
};

const RETRY_DELAY = 30_000;

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [screen,       setScreen]       = useState<AppScreen>('scanning');
  const [scanPct,      setScanPct]      = useState(0);
  const [scanMsg,      setScanMsg]      = useState('Recherche du serveur caisse…');
  const [orders,       setOrders]       = useState<ServiceOrder[]>([]);
  const [wsStatus,     setWsStatus]     = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [clock,        setClock]        = useState(new Date());
  const [deliveringId, setDeliveringId] = useState<number | null>(null);

  const wsRef        = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef      = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    activateKeepAwakeAsync();
    const clk = setInterval(() => setClock(new Date()), 1000);
    return () => { deactivateKeepAwake(); clearInterval(clk); };
  }, []);

  useEffect(() => { bootstrap(); return cleanup; }, []);

  const cleanup = () => {
    if (reconnectRef.current) clearTimeout(reconnectRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
    wsRef.current?.close();
  };

  const bootstrap = async () => {
    setScreen('scanning');
    setScanPct(0);
    const saved = await loadSavedUrl();
    if (saved) {
      setScanMsg('Connexion au serveur connu…');
      const ok = await testIp(saved.url);
      if (ok) { await saveUrl(ok.url, ok.restaurantId); connect(ok.url); return; }
      setScanMsg('Serveur introuvable, scan du réseau…');
      await clearUrl();
    }
    setScanMsg('Scan du réseau local…');
    const found = await scanNetwork((s, t) => setScanPct(Math.round((s / t) * 100)));
    if (found) { await saveUrl(found.url, found.restaurantId); connect(found.url); }
    else {
      setScanMsg('Serveur introuvable. Nouvelle tentative dans 30s…');
      reconnectRef.current = setTimeout(() => bootstrap(), RETRY_DELAY);
    }
  };

  const fetchOrders = useCallback(async () => {
    const url = getPosUrl();
    const resId = getRestaurantId();
    if (!url || !resId) return;
    try {
      const r = await fetch(`${url}/order/api/kds/orders/${resId}/?include_pending=1`);
      if (r.ok) {
        const data = await r.json();
        const done = (data.orders || []).filter((o: ServiceOrder) => o.kds_status === 'done');
        setOrders(done);
      }
    } catch {}
  }, []);

  const connect = (url: string) => {
    const wsUrl = url.replace(/^http/, 'ws') + '/ws/kds/';
    wsRef.current?.close();
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setWsStatus('connecting');

    ws.onopen = () => {
      setWsStatus('connected');
      setScreen('service');
      fetchOrders();
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(fetchOrders, 3000);
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type !== 'kds_message') return;
        const { type, order_id, kds_status } = msg.data;
        if (type === 'new_order') {
          fetchOrders();
        } else if (type === 'order_updated') {
          if (kds_status === 'delivered') {
            setOrders(prev => prev.filter(o => o.order_id !== order_id));
          } else if (kds_status === 'done') {
            fetchOrders(); // nouvelle commande prête → apparaît ici
          } else {
            setOrders(prev => prev.filter(o => o.order_id !== order_id));
          }
        }
      } catch {}
    };

    ws.onclose = () => {
      setWsStatus('disconnected');
      if (pollRef.current) clearInterval(pollRef.current);
      reconnectRef.current = setTimeout(() => bootstrap(), 5000);
    };
    ws.onerror = () => ws.close();
  };

  const markDelivered = async (orderId: number) => {
    if (deliveringId !== null) return;
    // Optimistic update — remove from list immediately
    setOrders(prev => prev.filter(o => o.order_id !== orderId));
    setDeliveringId(orderId);
    try {
      const url = getPosUrl();
      const r = await fetch(`${url}/order/api/Updateorder/${orderId}/`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kds_status: 'delivered' }),
      });
      if (!r.ok) fetchOrders();
    } catch { fetchOrders(); }
    finally { setDeliveringId(null); }
  };

  const getElapsed = (createdAt: string) => {
    const diff = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
    const m = Math.floor(diff / 60), sc = diff % 60;
    return { text: `${m}m ${String(sc).padStart(2, '0')}s`, urgent: m >= 5 };
  };

  // ── Scanning ─────────────────────────────────────────────────────────────────
  if (screen === 'scanning') {
    return (
      <View style={s.scanContainer}>
        <StatusBar hidden />
        <Text style={s.scanTitle}>ClickGo Service</Text>
        <Text style={s.scanMsg}>{scanMsg}</Text>
        <View style={s.progressBar}>
          <View style={[s.progressFill, { width: `${scanPct}%` as any }]} />
        </View>
        <Text style={s.scanPct}>{scanPct}%</Text>
      </View>
    );
  }

  // ── Service screen ───────────────────────────────────────────────────────────
  const sorted = [...orders].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  return (
    <View style={s.screen}>
      <StatusBar hidden />

      {/* Header */}
      <View style={s.header}>
        <Text style={s.headerTitle}>Service — Distribution</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <View style={[s.countBadge, { backgroundColor: orders.length > 0 ? '#10b981' : '#64748b' }]}>
            <Text style={s.countText}>{orders.length} prête{orders.length !== 1 ? 's' : ''}</Text>
          </View>
          <View style={s.wsRow}>
            <View style={[s.wsDot, {
              backgroundColor: wsStatus === 'connected' ? '#4ade80' : wsStatus === 'connecting' ? '#fbbf24' : '#f87171'
            }]} />
            <Text style={s.wsLabel}>{wsStatus === 'connected' ? 'En ligne' : wsStatus === 'connecting' ? 'Connexion…' : 'Hors ligne'}</Text>
          </View>
          <TouchableOpacity onPress={() => { clearUrl(); bootstrap(); }} style={s.rescanBtn}>
            <Text style={s.rescanText}>Changer serveur</Text>
          </TouchableOpacity>
          <Text style={s.clock}>
            {clock.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </Text>
        </View>
      </View>

      {/* Contenu */}
      {sorted.length === 0 ? (
        <View style={s.emptyScreen}>
          <Text style={s.emptyIcon}>✅</Text>
          <Text style={s.emptyTitle}>Tout est distribué !</Text>
          <Text style={s.emptySub}>Aucune commande en attente de distribution.</Text>
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.cardsList}
        >
          {sorted.map(order => {
            const { text: elapsed, urgent } = getElapsed(order.created_at);
            const dtype = order.delivery_type || (order.take_away ? 'emporter' : 'sur_place');
            const isDelivering = deliveringId === order.order_id;

            return (
              <View key={order.order_id} style={[s.card, urgent && s.cardUrgent]}>
                {/* Header */}
                <View style={s.cardHeader}>
                  <Text style={s.orderId}>#{String(order.order_id).padStart(3, '0')}</Text>
                  <View style={[s.badge, { backgroundColor: DELIVERY_COLOR[dtype] || '#64748b' }]}>
                    <Text style={s.badgeText}>{DELIVERY_LABEL[dtype] || dtype}</Text>
                  </View>
                </View>
                <Text style={[s.elapsed, urgent && s.elapsedUrgent]}>{urgent ? '⚠ ' : ''}{elapsed}</Text>

                {order.customer_identifier ? (
                  <View style={s.customerRow}>
                    <Text style={s.customerIcon}>👤</Text>
                    <Text style={s.customerText}>{order.customer_identifier}</Text>
                  </View>
                ) : null}

                <View style={s.divider} />

                {/* Items */}
                <ScrollView style={{ maxHeight: 200 }} showsVerticalScrollIndicator={false}>
                  {order.items.map((item, i) => (
                    <View key={i} style={{ marginBottom: 6 }}>
                      <Text style={s.itemName}>
                        <Text style={s.itemQty}>{item.quantity}×  </Text>
                        {item.menu_name}{item.solo ? ' (solo)' : item.extra ? ' +extra' : ''}
                      </Text>
                      {item.composition.map((opt, j) => (
                        <Text key={j} style={s.optLine}>{'  └ '}{opt.option_name}</Text>
                      ))}
                    </View>
                  ))}
                </ScrollView>

                <View style={s.divider} />

                {/* Total */}
                <Text style={s.total}>{order.total_price.toFixed(0)} DA</Text>

                {/* Bouton Livrer */}
                <TouchableOpacity
                  style={[s.deliverBtn, isDelivering && s.deliverBtnDisabled]}
                  onPress={() => markDelivered(order.order_id)}
                  disabled={deliveringId !== null}
                >
                  {isDelivering
                    ? <ActivityIndicator size="small" color="white" />
                    : <Text style={s.deliverBtnText}>✓ Livré</Text>
                  }
                </TouchableOpacity>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  // Scanning
  scanContainer:  { flex: 1, backgroundColor: '#064e3b', justifyContent: 'center', alignItems: 'center', padding: 40 },
  scanTitle:      { fontSize: 36, fontWeight: '800', color: 'white', marginBottom: 12 },
  scanMsg:        { fontSize: 16, color: '#6ee7b7', marginBottom: 24, textAlign: 'center' },
  progressBar:    { width: '60%', height: 8, backgroundColor: '#065f46', borderRadius: 4, overflow: 'hidden', marginBottom: 8 },
  progressFill:   { height: 8, backgroundColor: '#10b981', borderRadius: 4 },
  scanPct:        { fontSize: 14, color: '#6ee7b7', fontWeight: '600' },

  // Service screen
  screen:         { flex: 1, backgroundColor: '#f0fdf4' },
  header:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#064e3b', paddingHorizontal: 20, paddingVertical: 14 },
  headerTitle:    { fontSize: 20, fontWeight: '800', color: 'white' },
  countBadge:     { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 100 },
  countText:      { color: 'white', fontWeight: '700', fontSize: 14 },
  wsRow:          { flexDirection: 'row', alignItems: 'center', gap: 6 },
  wsDot:          { width: 8, height: 8, borderRadius: 4 },
  wsLabel:        { color: 'rgba(255,255,255,0.8)', fontSize: 12 },
  rescanBtn:      { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 8 },
  rescanText:     { color: 'white', fontSize: 12, fontWeight: '600' },
  clock:          { color: 'rgba(255,255,255,0.7)', fontSize: 14, fontFamily: 'monospace' },

  // Empty
  emptyScreen:    { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyIcon:      { fontSize: 80, marginBottom: 16 },
  emptyTitle:     { fontSize: 28, fontWeight: '800', color: '#059669' },
  emptySub:       { fontSize: 16, color: '#6ee7b7', marginTop: 8 },

  // Cards (scroll horizontal)
  cardsList:      { padding: 20, gap: 16, flexDirection: 'row', alignItems: 'flex-start' },
  card:           { backgroundColor: 'white', borderRadius: 16, padding: 16, width: 280, borderTopWidth: 4, borderTopColor: '#10b981', elevation: 4, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 10 },
  cardUrgent:     { borderTopColor: '#ef4444', backgroundColor: '#fff7f7' },
  cardHeader:     { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  orderId:        { fontSize: 22, fontWeight: '900', color: '#0f172a' },
  badge:          { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 100 },
  badgeText:      { color: 'white', fontSize: 11, fontWeight: '700' },
  elapsed:        { fontSize: 12, color: '#94a3b8', fontWeight: '600', marginBottom: 6 },
  elapsedUrgent:  { color: '#ef4444' },
  customerRow:    { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  customerIcon:   { fontSize: 14 },
  customerText:   { fontSize: 14, color: '#64748b', fontWeight: '600' },
  divider:        { height: 1, backgroundColor: '#f1f5f9', marginVertical: 10 },
  itemName:       { fontSize: 14, color: '#1e293b', fontWeight: '600' },
  itemQty:        { color: '#64748b', fontWeight: '700' },
  optLine:        { fontSize: 12, color: '#94a3b8' },
  total:          { fontSize: 20, fontWeight: '900', color: '#059669', textAlign: 'right', marginBottom: 10 },
  deliverBtn:     { backgroundColor: '#10b981', borderRadius: 14, paddingVertical: 16, alignItems: 'center', justifyContent: 'center' },
  deliverBtnDisabled: { backgroundColor: '#94a3b8' },
  deliverBtnText: { color: 'white', fontWeight: '800', fontSize: 18 },
});
