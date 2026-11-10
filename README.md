# Minas em Alerta

Protótipo web para explorar os acidentes de 2026 em Minas Gerais sem inventar ocorrências. O mapa e os filtros de ocorrências usam a base da PRF; os registros da SEJUSP são mostrados separadamente como totais de vítimas por município, pois essa base não descreve a rodovia nem a causa de cada acidente.

## Executar

Sirva a pasta por HTTP (o mapa vetorial não pode ser carregado abrindo `index.html` diretamente):

```powershell
python -m http.server 8000
```

Abra `http://localhost:8000`.

## Dados disponíveis no deploy

Os arquivos [`data/prf-2026.json`](./data/prf-2026.json) e [`data/sejusp-2026.json`](./data/sejusp-2026.json) são snapshots estáticos das fontes oficiais, incluídos no repositório. Ao publicar a pasta na Vercel, qualquer visitante recebe os dados automaticamente ao abrir o site; não precisa importar arquivos. O navegador baixa esses JSONs públicos diretamente da hospedagem estática. Não há servidor de aplicação, API própria ou envio de dados pessoais dos visitantes.

Os snapshots representam o último conjunto oficial publicado, não dados em tempo real. A PRF não oferece API: ela publica a planilha (ZIP no Google Drive) mais ou menos uma vez por mês. A SEJUSP publica o CSV no portal dados.mg.gov.br.

### Atualização automática

O workflow [`.github/workflows/update-data.yml`](./.github/workflows/update-data.yml) roda toda segunda-feira às 06:00 (horário de Brasília) e também pode ser disparado à mão em **Actions → Atualizar dados PRF e SEJUSP → Run workflow**. Ele executa [`scripts/update_data.py`](./scripts/update_data.py), que:

1. encontra o link **Acidentes 2026 (agrupados por ocorrência)** na página de [Dados Abertos da PRF](https://www.gov.br/prf/pt-br/acesso-a-informacao/dados-abertos/dados-abertos-da-prf) e baixa o ZIP do Google Drive;
2. consulta a API do [dados.mg.gov.br](https://dados.mg.gov.br/dataset/sejusp_vitimas_acidentes_transito) e baixa o CSV 2026 da SEJUSP;
3. gera os snapshots e só grava se algo mudou. Nesse caso o workflow faz um commit em `data/` e a Vercel publica a nova versão.

Proteções: se o link sumir ou o arquivo vier inválido, o workflow falha sem alterar nada e o GitHub envia um e-mail de falha. Também falha se a nova base da PRF tiver mais de 10% menos ocorrências que a atual. Se aparecer uma BR sem traçado no mapa, o log mostra um aviso para rodar `python scripts/build_roads.py`.

Para rodar localmente: `python scripts/update_data.py`.

Na virada do ano, o site e os scripts ainda usam 2026 fixo (nomes dos arquivos e textos), então será preciso ajustar o código.

### Atualização manual (alternativa)

1. Baixe **Acidentes 2026 (agrupados por ocorrência)** da PRF e o CSV 2026 da SEJUSP.
2. Gere os snapshots: `python scripts/generate_data.py --prf "caminho\datatran2026.zip" --sejusp "caminho\vitimas_acidente_transito_2026.csv"` (aceita também o CSV da PRF extraído).
3. Se surgir uma BR nova na base da PRF, regenere o traçado: `python scripts/build_roads.py` (geometria do OpenStreetMap via Overpass, gravada em `data/minas-gerais-brs.geojson`).
4. Revise as alterações em `data/` e publique.

## Fontes e limitações

- **PRF:** base de acidentes agrupada por ocorrência, atualizada mensalmente e com coordenadas, rodovia, horário, causa, tipo e vítimas. Abrange rodovias federais (BRs), não todas as rodovias estaduais.
- **SEJUSP-MG:** base estadual de vítimas provenientes dos registros REDS. O protótipo apresenta os registros por município, sem atribuir causa, rodovia ou ponto individual que não esteja confirmado.
- **Traçado das BRs:** [OpenStreetMap](https://www.openstreetmap.org/copyright) (© colaboradores do OSM, licença ODbL), simplificado por `scripts/build_roads.py`. Passe o mouse sobre uma BR para destacá-la e clique nela (ou no escudo) para filtrar o painel apenas por essa rodovia.
- **Limites municipais:** [geodata-br](https://github.com/tbrugz/geodata-br), arquivo de Minas Gerais disponibilizado sob licença CC0.

As fontes oficiais podem revisar registros e atualizar os arquivos. O conjunto incluído nesta publicação vai até a data exibida na interface.
