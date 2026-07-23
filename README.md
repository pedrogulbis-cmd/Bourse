# Scraper Trending Value — TradingView Screener

## Architecture (v4 — TradingView, remplace Yahoo Finance/Wikipedia)

Un seul appel API par pays donne **à la fois** l'univers de titres et leurs
fondamentaux (P/E, P/B, momentum 3/6 mois, rendement du dividende, rachats
d'actions...) — via le package `tradingview-screener`, un wrapper Python
autour de l'API officielle de TradingView (`scanner.tradingview.com`), pas
du scraping HTML.

**Pourquoi ce changement** : les architectures précédentes (screener Yahoo
par région, puis indices Wikipedia) souffraient soit d'une forte pollution
de cross-listings/certificats étrangers, soit d'une couverture limitée aux
grandes capitalisations. TradingView filtre nativement sur `is_primary`
(cotation primaire uniquement), ce qui règle le problème à la source.

## Installation

```bash
python -m venv venv
venv\Scripts\Activate.ps1        # Windows
pip install -r requirements.txt --break-system-packages   # ou sans ce flag si pas besoin
```

## Usage

```bash
python run.py                              # tous les pays configurés
python run.py --countries US,FR,DE         # seulement ces pays
python run.py --mcap-floor 200000000       # univers "All Stocks" du livre (200 M$)
python run.py --limit 20                   # test rapide, 20 titres max par pays
python run.py --debug                      # affiche un échantillon brut par pays (noms de colonnes, valeurs)
python run.py --export-only                # régénère juste data-snapshot.json depuis la base
python run.py --dedupe-only                # dédoublonne la base existante sans refetcher
```

## Points de vigilance (non confirmés en conditions réelles au moment de l'écriture)

- **Slugs de marché par pays** (`TV_MARKETS` dans `config.py`) : seuls `america`,
  `italy`, `germany` sont confirmés par la documentation officielle. Les autres
  (`france`, `uk`, `switzerland`...) sont des suppositions raisonnables mais à
  vérifier au premier run — un échec sur un pays n'empêche pas les autres de
  fonctionner.
- **Nom de champ pour le P/S** (`price_sales_current`) et le **rendement des
  rachats d'actions** (`buyback_yield`) : confirmés comme *indicateurs existants*
  sur TradingView (documentation/blog officiels), mais le nom exact du champ
  API n'a pas pu être vérifié en direct. Utiliser `--debug` sur un petit
  échantillon pour voir si ces colonnes reviennent `None`/vides — signe que le
  nom de champ est à corriger.
- **P/CF** (Price/Cash Flow) : aucun champ confirmé pour l'instant, laissé vide
  (traité comme donnée manquante par le calcul de score, rang neutre 50).

## Fichiers

- `config.py` — mapping pays -> marché/pays TradingView, seuils
- `universe.py` — la requête TradingView elle-même (`fetch_country_stocks`)
- `db.py` — couche SQLite (univers + fondamentaux + déduplication par nom)
- `export.py` — génère `data-snapshot.json` pour le site
- `run.py` — orchestrateur / CLI
