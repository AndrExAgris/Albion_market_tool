.PHONY: help up down restart clean update logs status

help:
	@echo "Albion Market Tool — comandos disponíveis:"
	@echo "  make up       - sobe os containers (builda se necessário)"
	@echo "  make down     - para e remove os containers"
	@echo "  make restart  - reinicia (down + up)"
	@echo "  make clean    - para os containers e apaga volumes + imagens locais (some com o cache do catálogo)"
	@echo "  make update   - baixa a última versão do repositório e reconstrói"
	@echo "  make logs     - acompanha os logs dos containers em tempo real"
	@echo "  make status   - mostra se os containers estão rodando"

up:
	docker compose up -d --build

down:
	docker compose down

restart: down up

clean:
	docker compose down -v --rmi local

update:
	git pull
	docker compose up -d --build

logs:
	docker compose logs -f

status:
	docker compose ps