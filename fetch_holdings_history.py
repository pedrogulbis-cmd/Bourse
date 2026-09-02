#!/usr/bin/env python3
"""
Récupère l'historique réel de prix de chaque action de ton portefeuille,
depuis leur date d'achat jusqu'à aujourd'hui — via tvDatafeed, la même
librairie que pour les indices (scanner Yahoo classique ne fait pas
d'historique). Permet une VRAIE courbe rétroactive de la valeur du
portefeuille, pas seulement un suivi qui démarre à partir d'aujourd'hui.

Ce script n'a PAS d'accès direct à ton portefeuille : il vit dans ton
navigateur (localStorage), pas sur ton PC. Il faut d'abord l'exporter :

    1. Sur la page Portefeuille du site, clique "↓ Exporter mes données"
    2. Place le fichier téléchargé dans ce dossier (scraper/)
    3. Lance : python fetch_holdings_history.py --input export.json --suffix TONPRENOM

PLUSIEURS UTILISATEURS DU MÊME SITE : le paramètre --suffix évite que
deux personnes partageant le même dépôt GitHub Pages n'écrasent le
fichier l'une de l'autre. Avec --suffix popo, ce script écrit
holdings-history-popo.json (au lieu de holdings-history.json), et
l'enregistre dans un petit annuaire partagé (holdings-history-index.json)
que le site consulte pour proposer automatiquement "popo" comme choix,
sans que personne n'ait à taper le nom à la main.

Usage :
    python fetch_holdings_history.py --input mon-export.json --suffix popo
    python fetch_holdings_history.py --input mon-export.json --suffix popo --bars 1500
    python fetch_holdings_history.py --input mon-export.json   (sans --suffix : usage solo, comme avant)
"""
import argparse
import base64
import getpass
import json
import os
import urllib.request
from datetime import datetime, timezone

from tvDatafeed import TvDatafeed, Interval

try:
    from config import SITE_BASE_URL
except ImportError:
    SITE_BASE_URL = None

INDEX_PATH = "holdings-history-index.json"
PBKDF2_ITERATIONS = 200_000  # coût volontairement élevé pour ralentir une attaque par force brute sur le mot de passe


def fetch_one(tv, symbol, n_bars):
    df = tv.get_hist(symbol=symbol, interval=Interval.in_daily, n_bars=n_bars)
    if df is None or df.empty:
        raise ValueError("aucune donnée retournée (symbole probablement incorrect ou retiré de la cote)")
    return [
        {"date": idx.strftime("%Y-%m-%d"), "close": float(row["close"])}
        for idx, row in df.iterrows()
    ]


def encrypt_payload(data_dict, passphrase):
    """Chiffre un dict en AES-GCM avec une clé dérivée du mot de passe
    (PBKDF2-SHA256, 200 000 itérations). Compatible avec le déchiffrement
    fait côté navigateur via l'API Web Crypto native (crypto.subtle) —
    aucune dépendance JS supplémentaire à charger, aucun mot de passe
    jamais stocké dans le fichier lui-même ou dans le dépôt.

    Retourne un dict {encrypted: true, salt, iv, ciphertext, iterations} —
    le sel et le vecteur d'initialisation n'ont PAS besoin d'être secrets
    (c'est la nature même de ces valeurs), seul le mot de passe compte."""
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    payload = json.dumps(data_dict, separators=(",", ":")).encode("utf-8")
    salt = os.urandom(16)
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=PBKDF2_ITERATIONS)
    key = kdf.derive(passphrase.encode("utf-8"))
    iv = os.urandom(12)  # taille standard du nonce pour AES-GCM
    ciphertext = AESGCM(key).encrypt(iv, payload, None)

    return {
        "encrypted": True,
        "salt": base64.b64encode(salt).decode("ascii"),
        "iv": base64.b64encode(iv).decode("ascii"),
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        "iterations": PBKDF2_ITERATIONS,
    }


def fetch_remote_index(site_base_url):
    """Récupère l'annuaire déjà en ligne sur le site (s'il existe), pour
    fusionner avec au lieu d'écraser — fonctionne même si ce PC n'a jamais
    lancé ce script auparavant. Retourne une liste vide en cas d'échec
    (site non configuré, hors ligne, fichier pas encore créé...)."""
    if not site_base_url:
        return []
    url = site_base_url.rstrip("/") + "/holdings-history-index.json"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            remote = json.loads(resp.read().decode("utf-8"))
        remote_suffixes = remote.get("suffixes", [])
        if isinstance(remote_suffixes, list):
            print(f"— Annuaire en ligne récupéré ({url}) : {', '.join(remote_suffixes) or '(vide)'}")
            return remote_suffixes
    except Exception as e:
        print(f"— Annuaire en ligne non récupéré ({e}) — fusion avec le fichier local uniquement.")
    return []


def update_index(suffix, index_path=INDEX_PATH, site_base_url=None):
    """Ajoute ce suffixe à l'annuaire partagé, SANS écraser les entrées
    déjà déposées par d'autres utilisateurs — fusionne l'existant local ET
    la version en ligne (si site_base_url est configuré dans config.py),
    pour rester correct même en lançant le script depuis un PC différent
    de celui utilisé la dernière fois."""
    suffixes = set(fetch_remote_index(site_base_url))
    if os.path.exists(index_path):
        try:
            with open(index_path, "r", encoding="utf-8") as f:
                existing = json.load(f)
            if isinstance(existing.get("suffixes"), list):
                suffixes.update(existing["suffixes"])
        except Exception:
            pass  # annuaire local corrompu ou illisible -> tant pis, on continue avec ce qu'on a
    suffixes.add(suffix)
    suffixes = sorted(suffixes)
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump({
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "suffixes": suffixes,
        }, f, separators=(",", ":"))
    print(f"— Annuaire mis à jour ({index_path}) : {', '.join(suffixes)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=str, default=None, help="Fichier JSON exporté depuis la page Portefeuille.")
    ap.add_argument("--symbols", type=str, default=None,
                     help="Liste de symboles séparés par des virgules (ex. \"EURONEXT:MC,OSL:HAUTO\"), au lieu d'un fichier d'export. Utilisé par l'automatisation GitHub Actions, qui n'a pas accès au portefeuille stocké dans le navigateur.")
    ap.add_argument("--bars", type=int, default=1500, help="Nombre de barres quotidiennes par titre (max 5000, ~6 ans).")
    ap.add_argument("--suffix", type=str, default=None,
                     help="Identifiant personnel (ex. ton prénom) si plusieurs personnes partagent ce site — voir docstring en haut du fichier.")
    ap.add_argument("--out", type=str, default=None, help="Nom de fichier explicite (remplace le calcul automatique à partir de --suffix).")
    ap.add_argument("--site-url", type=str, default=None, help="URL du site (remplace SITE_BASE_URL de config.py) pour fusionner avec l'annuaire déjà en ligne, sans avoir à éditer config.py.")
    ap.add_argument("--encrypt", action="store_true",
                     help="Chiffre le fichier de sortie (AES-GCM) — recommandé dès que le dépôt GitHub est public, pour que la liste de tes titres ne soit pas lisible en clair par n'importe qui. Demande un mot de passe (saisie masquée) si --passphrase n'est pas fourni.")
    ap.add_argument("--passphrase", type=str, default=None,
                     help="Mot de passe pour --encrypt, fourni directement (déconseillé : reste dans l'historique de ta console/terminal) plutôt que saisi de façon masquée.")
    args = ap.parse_args()

    if not args.input and not args.symbols:
        ap.error("Fournis soit --input (fichier d'export), soit --symbols (liste directe).")

    if args.symbols:
        symbols = sorted({s.strip() for s in args.symbols.split(",") if s.strip()})
        holdings = None
    else:
        with open(args.input, "r", encoding="utf-8") as f:
            data = json.load(f)

        # Le format d'export a changé avec l'arrivée des portefeuilles multiples :
        # les positions sont maintenant nichées dans data["portfolios"][i]["holdings"]
        # plutôt qu'à la racine. On gère les deux formats pour rester compatible
        # avec d'anciens exports.
        if isinstance(data.get("portfolios"), list):
            holdings = [h for p in data["portfolios"] for h in p.get("holdings", [])]
        else:
            holdings = data.get("holdings", [])

        if not holdings:
            print("Aucune position trouvée dans le fichier exporté.")
            return

        symbols = sorted({h["symbol"] for h in holdings if h.get("symbol")})
    print(f"— {len(symbols)} titre(s) unique(s) à récupérer : {', '.join(symbols)}")

    tv = TvDatafeed()
    out = {}
    for symbol in symbols:
        try:
            points = fetch_one(tv, symbol, args.bars)
            out[symbol] = points
            print(f"  {symbol} : {len(points)} points, du {points[0]['date']} au {points[-1]['date']}")
        except Exception as e:
            print(f"  ⚠ échec {symbol} : {e}")

    if not out:
        print("Rien récupéré — rien écrit.")
        return

    if args.out:
        out_filename = args.out
    elif args.suffix:
        out_filename = f"holdings-history-{args.suffix}.json"
    else:
        out_filename = "holdings-history.json"

    snapshot = {"generatedAt": datetime.now(timezone.utc).isoformat(), "prices": out}

    if args.encrypt:
        passphrase = args.passphrase or getpass.getpass(
            "Mot de passe pour chiffrer ce fichier (à retenir — sans lui, personne, toi y compris, ne peut le déchiffrer) : "
        )
        if not passphrase:
            print("Mot de passe vide — abandon, rien n'a été écrit.")
            return
        snapshot = encrypt_payload(snapshot, passphrase)
        print("— Contenu chiffré (AES-GCM) avant écriture.")

    with open(out_filename, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, separators=(",", ":"))
    print(f"— Écrit : {out_filename}")

    if args.suffix:
        update_index(args.suffix, site_base_url=args.site_url or SITE_BASE_URL)


if __name__ == "__main__":
    main()
