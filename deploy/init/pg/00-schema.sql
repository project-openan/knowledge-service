-- OpenAN Knowledge Service 数据库初始化。
-- （函数/表/序列/列默认/约束/索引/触发器/内部 FK），
--
-- PostgreSQL database dump
--
-- 本文件是 **核心静态表的 schema 快照**（22 张业务表 + kb_index schema），
-- 由默认 docker-compose.yml 挂到 /docker-entrypoint-initdb.d/，只在空 PGDATA 上执行。
--
-- 空卷初始化的权威 schema。
-- （pg_dump --schema-only），并经空卷启动验证。动态 doc_* / graph_* 表不在快照内，
-- 仍由应用按需创建。表名、审计列与命名规范见
-- docs/database-schema.md。
--
-- ⚠️ 本文件只在空卷（PGDATA 为空）时执行一次。

-- 动态向量表使用 vector(N)，扩展必须在建表前存在。
CREATE EXTENSION IF NOT EXISTS vector;
-- 可观测性（P1）：慢查询统计；compose 的 command 已 preload。
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- 动态每库表所在 schema（运行时由应用建表）。
CREATE SCHEMA IF NOT EXISTS kb_index;

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15 (Debian 16.15-1.pgdg12+2)
-- Dumped by pg_dump version 16.15 (Debian 16.15-1.pgdg12+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
        NEW.updated_at = now();
        RETURN NEW;
    END;
    $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: auth_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_session (
    id bigint NOT NULL,
    token_hash character(64) NOT NULL,
    user_id bigint NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    ip character varying(64),
    user_agent character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_session_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auth_session_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auth_session_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auth_session_id_seq OWNED BY public.auth_session.id;


--
-- Name: auth_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_user (
    id bigint NOT NULL,
    username character varying(64) NOT NULL,
    email character varying(255),
    display_name character varying(128),
    password_hash character varying(255) NOT NULL,
    role character varying(16) DEFAULT 'user'::character varying NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    must_change_password boolean DEFAULT false NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_user_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auth_user_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auth_user_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auth_user_id_seq OWNED BY public.auth_user.id;


--
-- Name: kb_directory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kb_directory (
    id character varying(32) NOT NULL,
    kbase_id character varying(32) NOT NULL,
    title character varying(255),
    parent_id character varying(32),
    parent_path character varying(500),
    type character varying(32) NOT NULL,
    created_by character varying(255),
    updated_by character varying(255),
    status smallint,
    fail_reason character varying(1024),
    file_from character varying(10),
    can_spread boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_kb_directory_status CHECK (((status IS NULL) OR (status = ANY (ARRAY['-4'::integer, '-3'::integer, '-2'::integer, '-1'::integer, 0, 1, 2])))),
    CONSTRAINT ck_kb_directory_type CHECK (((type)::text = ANY ((ARRAY['file'::character varying, 'folder'::character varying])::text[])))
);


--
-- Name: kb_directory_property; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kb_directory_property (
    id character varying(32) NOT NULL,
    file_id character varying(32) NOT NULL,
    kbase_id character varying(32) NOT NULL,
    prop_name character varying(255),
    prop_value character varying(1024),
    created_by character varying(255),
    updated_by character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: kb_import_task; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kb_import_task (
    id character varying(32) NOT NULL,
    task_type character varying(255),
    related_identifier_id character(32),
    created_by character varying(255),
    updated_by character varying(255),
    status character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_kb_import_task_status CHECK (((status IS NULL) OR ((status)::text = ANY ((ARRAY['PENDING'::character varying, 'RUNNING'::character varying, 'RETRY'::character varying, 'COMPLETED'::character varying, 'FAILED'::character varying])::text[]))))
);


--
-- Name: kb_kbase; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kb_kbase (
    id integer NOT NULL,
    kbase_id character varying(32) NOT NULL,
    type character varying(255) DEFAULT 'document'::character varying NOT NULL,
    name character varying(255) NOT NULL,
    description character varying(1000),
    head_icon character varying(255),
    es_index_name character varying(255),
    embedding_model character varying(255),
    created_by character varying(255),
    updated_by character varying(255),
    file_count_limit integer DEFAULT 3000 NOT NULL,
    org_id character varying(512),
    table_name character varying(255),
    operator_id integer,
    schema_id character varying(100),
    schema_obj jsonb,
    fail_reason_obj jsonb,
    category smallint DEFAULT 1 NOT NULL,
    status smallint DEFAULT 0 NOT NULL,
    process character varying(50),
    process_obj jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_kb_kbase_category CHECK ((category = ANY (ARRAY[1, 10]))),
    CONSTRAINT ck_kb_kbase_status CHECK ((status = ANY (ARRAY[0, 1, 2, 3, 4, 5, 6, 7, 8, 101, 102, 103, 104, 106]))),
    CONSTRAINT ck_kb_kbase_type CHECK (((type)::text = 'document'::text))
);


--
-- Name: kb_kbase_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.kb_kbase ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.kb_kbase_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: kb_storage_registry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kb_storage_registry (
    kbase_id character varying(64) NOT NULL,
    name character varying(255) NOT NULL,
    category smallint,
    vector_table character varying(255),
    chunk_table character varying(255),
    graph_vector_table character varying(255),
    embedding_model character varying(255),
    embedding_dim integer,
    state character varying(16) NOT NULL,
    detail text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: operator; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    name_en character varying(255),
    description character varying(1000) NOT NULL,
    description_en character varying(1000),
    module character varying(255) NOT NULL,
    visible_range character varying(255) NOT NULL,
    version character varying(255) NOT NULL,
    is_published boolean DEFAULT false NOT NULL,
    operator_zip_path character varying(512),
    operator_path character varying(512),
    created_by character varying(255),
    updated_by character varying(255),
    system boolean DEFAULT false NOT NULL,
    org_id character varying(512),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: operator_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.operator ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.operator_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: operator_param; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_param (
    id integer NOT NULL,
    operator_id integer NOT NULL,
    arg_name character varying(255) NOT NULL,
    arg_type character varying(1000) NOT NULL,
    description character varying(1000) NOT NULL,
    default_value character varying(255),
    tips text,
    placeholder text,
    created_by character varying(255),
    updated_by character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: operator_param_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.operator_param ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.operator_param_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: operator_prop; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_prop (
    id integer NOT NULL,
    operator_id integer NOT NULL,
    prop_name character varying(255) NOT NULL,
    prop_value character varying(255) NOT NULL,
    created_by character varying(255),
    updated_by character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: operator_prop_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.operator_prop ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.operator_prop_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: auth_session id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session ALTER COLUMN id SET DEFAULT nextval('public.auth_session_id_seq'::regclass);


--
-- Name: auth_user id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user ALTER COLUMN id SET DEFAULT nextval('public.auth_user_id_seq'::regclass);


--
-- Name: auth_session auth_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session
    ADD CONSTRAINT auth_session_pkey PRIMARY KEY (id);


--
-- Name: auth_user auth_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_user
    ADD CONSTRAINT auth_user_pkey PRIMARY KEY (id);


--
-- Name: kb_directory kb_directory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_directory
    ADD CONSTRAINT kb_directory_pkey PRIMARY KEY (id);


--
-- Name: kb_directory_property kb_directory_property_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_directory_property
    ADD CONSTRAINT kb_directory_property_pkey PRIMARY KEY (id);


--
-- Name: kb_import_task kb_import_task_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_import_task
    ADD CONSTRAINT kb_import_task_pkey PRIMARY KEY (id);


--
-- Name: kb_kbase kb_kbase_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_kbase
    ADD CONSTRAINT kb_kbase_pkey PRIMARY KEY (id);


--
-- Name: kb_storage_registry kb_storage_registry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_storage_registry
    ADD CONSTRAINT kb_storage_registry_pkey PRIMARY KEY (kbase_id);


--
-- Name: operator_param operator_param_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_param
    ADD CONSTRAINT operator_param_pkey PRIMARY KEY (id);


--
-- Name: operator operator_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator
    ADD CONSTRAINT operator_pkey PRIMARY KEY (id);


--
-- Name: operator_prop operator_prop_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_prop
    ADD CONSTRAINT operator_prop_pkey PRIMARY KEY (id);


--
-- Name: auth_session_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_session_expires_at_idx ON public.auth_session USING btree (expires_at);


--
-- Name: auth_session_token_hash_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_session_token_hash_uidx ON public.auth_session USING btree (token_hash);


--
-- Name: auth_session_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_session_user_id_idx ON public.auth_session USING btree (user_id);


--
-- Name: auth_user_email_lower_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_user_email_lower_uidx ON public.auth_user USING btree (lower((email)::text)) WHERE (email IS NOT NULL);


--
-- Name: auth_user_username_lower_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_user_username_lower_uidx ON public.auth_user USING btree (lower((username)::text));


--
-- Name: idx_directory_kbase_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_directory_kbase_parent ON public.kb_directory USING btree (kbase_id, parent_id);


--
-- Name: idx_kb_directory_kbase_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_kb_directory_kbase_type ON public.kb_directory USING btree (kbase_id, type);


--
-- Name: kb_directory_folder_title_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX kb_directory_folder_title_uidx ON public.kb_directory USING btree (kbase_id, COALESCE(parent_id, ''::character varying), title) WHERE ((type)::text = 'folder'::text);


--
-- Name: kb_directory_property_file_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX kb_directory_property_file_id_idx ON public.kb_directory_property USING btree (file_id);


--
-- Name: kb_directory_property_file_prop_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX kb_directory_property_file_prop_uidx ON public.kb_directory_property USING btree (file_id, prop_name);


--
-- Name: kb_directory_property_kbase_file_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX kb_directory_property_kbase_file_idx ON public.kb_directory_property USING btree (kbase_id, file_id);


--
-- Name: kb_import_task_task_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX kb_import_task_task_type_idx ON public.kb_import_task USING btree (task_type, related_identifier_id);


--
-- Name: kb_kbase_es_index_name_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX kb_kbase_es_index_name_uidx ON public.kb_kbase USING btree (es_index_name);


--
-- Name: kb_kbase_kbase_id_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX kb_kbase_kbase_id_uidx ON public.kb_kbase USING btree (kbase_id);


--
-- Name: kb_kbase_name_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX kb_kbase_name_uidx ON public.kb_kbase USING btree (name);


--
-- Name: kb_storage_registry_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX kb_storage_registry_state_idx ON public.kb_storage_registry USING btree (state);


--
-- Name: kb_storage_registry_vector_table_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX kb_storage_registry_vector_table_uidx ON public.kb_storage_registry USING btree (vector_table);


--
-- Name: operator_module_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operator_module_idx ON public.operator USING btree (module);


--
-- Name: operator_param_operator_arg_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX operator_param_operator_arg_uidx ON public.operator_param USING btree (operator_id, arg_name);


--
-- Name: operator_param_operator_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operator_param_operator_id_idx ON public.operator_param USING btree (operator_id);


--
-- Name: operator_prop_operator_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operator_prop_operator_id_idx ON public.operator_prop USING btree (operator_id);


--
-- Name: operator_prop_operator_prop_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX operator_prop_operator_prop_uidx ON public.operator_prop USING btree (operator_id, prop_name);


--
-- Name: auth_session auth_session_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_session_set_updated_at BEFORE UPDATE ON public.auth_session FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: auth_user auth_user_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_user_set_updated_at BEFORE UPDATE ON public.auth_user FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: kb_directory_property kb_directory_property_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER kb_directory_property_set_updated_at BEFORE UPDATE ON public.kb_directory_property FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: kb_directory kb_directory_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER kb_directory_set_updated_at BEFORE UPDATE ON public.kb_directory FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: kb_import_task kb_import_task_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER kb_import_task_set_updated_at BEFORE UPDATE ON public.kb_import_task FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: kb_kbase kb_kbase_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER kb_kbase_set_updated_at BEFORE UPDATE ON public.kb_kbase FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: kb_storage_registry kb_storage_registry_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER kb_storage_registry_set_updated_at BEFORE UPDATE ON public.kb_storage_registry FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: operator_param operator_param_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER operator_param_set_updated_at BEFORE UPDATE ON public.operator_param FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: operator_prop operator_prop_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER operator_prop_set_updated_at BEFORE UPDATE ON public.operator_prop FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: operator operator_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER operator_set_updated_at BEFORE UPDATE ON public.operator FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.kb_node_relation (
    id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    kbase_id varchar(32) NOT NULL REFERENCES public.kb_kbase(kbase_id) ON DELETE CASCADE,
    directory_id varchar(32) NOT NULL REFERENCES public.kb_directory(id) ON DELETE CASCADE,
    node_id varchar NOT NULL,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX kb_node_relation_directory_id_idx ON public.kb_node_relation (directory_id);
CREATE UNIQUE INDEX kb_node_relation_kbase_node_uidx ON public.kb_node_relation (kbase_id, node_id);
CREATE TRIGGER kb_node_relation_set_updated_at BEFORE UPDATE ON public.kb_node_relation
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
