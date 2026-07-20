# Albion Market Tool

Interface web para explorar os preços de mercado do Albion Online usando dados da [Albion Online Data Project (AODP)](https://www.albion-online-data.com/).

## Como rodar

### Instalação

```bash
git clone https://github.com/AndrExAgris/Albion_market_tool.git
cd Albion_market_tool
docker compose up -d --build
```

A ferramenta fica disponível em `http://localhost:8069`.

### Atualização

```bash
git pull
docker compose up -d --build

```

### Parar os containers

```bash
docker compose down
```

### Apagar tudo

```bash
docker compose down -v --rmi local
```

## Makefile

Pra não precisar aprender docker:

| Comando | O que faz |
|---|---|
| `make up` | Sobe os containers |
| `make down` | Para os containers, sem apagar nada |
| `make restart` | `down` + `up` |
| `make clean` | Para os containers e apaga imagens locais + volume do cache |
| `make update` | `git pull` + reconstrói os containers = atualização |
| `make logs` | Mostra os logs dos containers em tempo real (útil pra debugar) |
| `make status` | Mostra se os containers estão rodando |

Rodando só `make` mostra essa mesma lista na tela.

## Estrutura do projeto

```
Albion_market_tool/
├── docker-compose.yml
├── Makefile
├── Dockerfile
├── nginx.conf
├── albion_market_explorer.html   (frontend, arquivo único)
└── backend/
    ├── Dockerfile
    ├── package.json
    ├── server.js
    └── natsClient.js
```

## Fonte dos dados

Os preços são fornecidos voluntariamente por jogadores através da [Albion Online Data Project](https://www.albion-online-data.com/) — podem estar desatualizados em itens ou cidades com pouco movimento. Os valores exibidos são brutos, sem descontar a taxa de mercado do jogo. As receitas de craft e os bônus de cidade vêm dos arquivos de dados oficiais do jogo ([ao-data/ao-bin-dumps](https://github.com/ao-data/ao-bin-dumps)).

## Licença

Distribuído sob a licença [GPL-3.0](LICENSE).