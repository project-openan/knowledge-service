-- Studio additions from Co-Knowledge (Apache-2.0). See the repository NOTICE.
-- Keep the foundation tables and data. Task history is migrated by 10–17 below.
BEGIN;

CREATE SCHEMA IF NOT EXISTS task_center;

DO $studio_schema$
BEGIN
    IF to_regclass('public.chat_query_trace') IS NOT NULL
       AND to_regclass('public.flow_draft') IS NOT NULL
       AND to_regclass('public.flow_release') IS NOT NULL
       AND to_regclass('public.flow_workflow') IS NOT NULL
       AND to_regclass('public.graph_extract_task') IS NOT NULL
       AND to_regclass('public.graph_import_task') IS NOT NULL
       AND to_regclass('public.graph_registry') IS NOT NULL
       AND to_regclass('public.graph_schema') IS NOT NULL
       AND to_regclass('public.model_registry') IS NOT NULL THEN
        RETURN;
    END IF;

--
-- Name: chat_query_trace; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_query_trace (
    id bigint NOT NULL,
    trace_id character varying(64) DEFAULT ''::character varying NOT NULL,
    conversation_id character varying(128) DEFAULT ''::character varying NOT NULL,
    workflow_id character varying(128) DEFAULT ''::character varying NOT NULL,
    org_id character varying(128) DEFAULT ''::character varying NOT NULL,
    is_stream boolean DEFAULT false NOT NULL,
    status character varying(24) NOT NULL,
    error_code character varying(128) DEFAULT ''::character varying NOT NULL,
    http_status smallint,
    error_status smallint,
    question_len integer DEFAULT 0 NOT NULL,
    answer_len integer DEFAULT 0 NOT NULL,
    understanding_ms numeric(12,1),
    retrieval_ms numeric(12,1),
    rerank_ms numeric(12,1),
    generate_ms numeric(12,1),
    first_token_ms numeric(12,1),
    total_ms numeric(12,1),
    hit_count integer DEFAULT 0 NOT NULL,
    source_count integer DEFAULT 0 NOT NULL,
    kb_count integer DEFAULT 0 NOT NULL,
    top_score numeric(12,4),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chat_query_trace_status_check CHECK (((status)::text = ANY ((ARRAY['ok'::character varying, 'error'::character varying, 'client_disconnect'::character varying])::text[])))
);

--
-- Name: TABLE chat_query_trace; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.chat_query_trace IS '查询链路指标（append-only，按保留期清理）';

--
-- Name: chat_query_trace_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.chat_query_trace_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: chat_query_trace_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.chat_query_trace_id_seq OWNED BY public.chat_query_trace.id;

--
-- Name: flow_draft; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flow_draft (
    id bigint NOT NULL,
    workflow_id character varying(128) NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    flow_type character varying(32) DEFAULT 'workflow'::character varying NOT NULL,
    node_config jsonb NOT NULL,
    other_node_config jsonb NOT NULL,
    created_by character varying(255),
    updated_by character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: TABLE flow_draft; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.flow_draft IS '工作流草稿（当前编辑态）';

--
-- Name: COLUMN flow_draft.node_config; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.flow_draft.node_config IS 'nodeConfigDTOList（原样往返）';

--
-- Name: flow_draft_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.flow_draft_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: flow_draft_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.flow_draft_id_seq OWNED BY public.flow_draft.id;

--
-- Name: flow_release; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flow_release (
    id bigint NOT NULL,
    workflow_id character varying(128) NOT NULL,
    version integer NOT NULL,
    node_config jsonb NOT NULL,
    other_node_config jsonb NOT NULL,
    created_by character varying(255),
    updated_by character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: TABLE flow_release; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.flow_release IS '工作流发布快照（不可变版本）';

--
-- Name: flow_release_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.flow_release_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: flow_release_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.flow_release_id_seq OWNED BY public.flow_release.id;

--
-- Name: flow_workflow; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flow_workflow (
    id bigint NOT NULL,
    workflow_id character varying(128) NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    template character varying(64),
    knowledge_type character varying(32),
    publish_type smallint DEFAULT 0 NOT NULL,
    status smallint DEFAULT 1 NOT NULL,
    bound_info jsonb,
    created_by character varying(255),
    updated_by character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_flow_workflow_publish_type CHECK ((publish_type = ANY (ARRAY[0, 1, 2]))),
    CONSTRAINT ck_flow_workflow_status CHECK ((status >= 0))
);

--
-- Name: TABLE flow_workflow; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.flow_workflow IS '工作流主表';

--
-- Name: COLUMN flow_workflow.publish_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.flow_workflow.publish_type IS '0=未发布 1=已发布 2=发布后再改动';

--
-- Name: COLUMN flow_workflow.bound_info; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.flow_workflow.bound_info IS '建流时选中的知识库（按发布状态分组，JSON 原样存）';

--
-- Name: flow_workflow_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.flow_workflow_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: flow_workflow_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.flow_workflow_id_seq OWNED BY public.flow_workflow.id;

--
-- Name: graph_extract_task; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.graph_extract_task (
    id character varying(100) NOT NULL,
    kb_id character varying(100) NOT NULL,
    schema_id character varying(100) NOT NULL,
    operator_id integer NOT NULL,
    file_count integer NOT NULL,
    status character varying(20) NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    error_message text,
    result_file_path text,
    created_by character varying(255),
    start_time timestamp with time zone,
    finish_time timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_graph_extract_task_status CHECK (((status)::text = ANY ((ARRAY['INIT'::character varying, 'RUNNING'::character varying, 'SUCCESS'::character varying, 'FAIL'::character varying])::text[])))
);

--
-- Name: TABLE graph_extract_task; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.graph_extract_task IS '图谱抽取任务（kb_id 为裸 kbase_id）';

--
-- Name: COLUMN graph_extract_task.kb_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.graph_extract_task.kb_id IS '裸 kbase_id（不含 graph_ 前缀）';

--
-- Name: COLUMN graph_extract_task.start_time; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.graph_extract_task.start_time IS '开始时间（timestamptz）';

--
-- Name: COLUMN graph_extract_task.finish_time; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.graph_extract_task.finish_time IS '结束时间（timestamptz）';

--
-- Name: graph_import_task; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.graph_import_task (
    task_id character varying(100) NOT NULL,
    kb_id character varying(1000) NOT NULL,
    schema_id character varying(100) NOT NULL,
    status character varying(50) NOT NULL,
    progress integer DEFAULT 0,
    entity_total integer DEFAULT 0,
    entity_success integer DEFAULT 0,
    entity_failed integer DEFAULT 0,
    edge_total integer DEFAULT 0,
    edge_success integer DEFAULT 0,
    edge_failed integer DEFAULT 0,
    failed_records jsonb,
    error_message character varying(20000),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_graph_import_task_status CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'PROCESSING'::character varying, 'COMPLETED'::character varying, 'COMPLETED_WITH_ERRORS'::character varying, 'FAILED'::character varying])::text[])))
);

--
-- Name: TABLE graph_import_task; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.graph_import_task IS '图谱导入任务（文本状态机）';

--
-- Name: COLUMN graph_import_task.kb_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.graph_import_task.kb_id IS 'graph_<kbase_id>';

--
-- Name: graph_registry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.graph_registry (
    kb_id character varying(1000) NOT NULL,
    schema_id character varying(100) NOT NULL,
    graph_name character varying(100),
    graph_desc character varying(1000),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: TABLE graph_registry; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.graph_registry IS '图谱库登记（kb_id = graph_<uuid>）';

--
-- Name: COLUMN graph_registry.kb_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.graph_registry.kb_id IS '图谱库名 graph_<uuid>';

--
-- Name: graph_schema; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.graph_schema (
    schema_id character varying(100) NOT NULL,
    schema_name character varying(100) NOT NULL,
    schema_desc character varying(1000),
    schema_obj jsonb NOT NULL,
    created_by character varying(100),
    updated_by character varying(100),
    status smallint DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_graph_schema_status CHECK (((status IS NULL) OR (status = ANY (ARRAY[0, 1]))))
);

--
-- Name: TABLE graph_schema; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.graph_schema IS '图谱 schema 模板与快照';

--
-- Name: COLUMN kb_kbase.schema_obj; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.kb_kbase.schema_obj IS '建库时的 schema 快照（不随 graph_schema 模板变化）';

--
-- Name: model_registry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_registry (
    model_id character varying(64) NOT NULL,
    model_kind character varying(16) NOT NULL,
    model_name character varying(255) NOT NULL,
    display_name character varying(255),
    api_model character varying(255),
    base_url character varying(1000) NOT NULL,
    api_key character varying(2000),
    chat_path character varying(255),
    embeddings_path character varying(255),
    models_path character varying(255),
    rerank_path character varying(255),
    dimension integer,
    max_tokens integer,
    temperature numeric(6,4),
    timeout integer,
    is_reasoning boolean DEFAULT false NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    source character varying(16) DEFAULT 'user'::character varying NOT NULL,
    remark character varying(500),
    created_by character varying(255),
    thinking_mode character varying(16) DEFAULT 'none'::character varying NOT NULL,
    thinking_preset character varying(64),
    thinking_payload jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ck_model_registry_kind CHECK (((model_kind)::text = ANY ((ARRAY['llm'::character varying, 'embedding'::character varying, 'rerank'::character varying])::text[]))),
    CONSTRAINT ck_model_registry_source CHECK (((source)::text = ANY ((ARRAY['env'::character varying, 'user'::character varying])::text[]))),
    CONSTRAINT ck_model_registry_thinking_mode CHECK (((thinking_mode)::text = ANY ((ARRAY['none'::character varying, 'auto'::character varying, 'preset'::character varying, 'custom'::character varying])::text[])))
);

--
-- Name: TABLE model_registry; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.model_registry IS '模型注册表（llm/embedding/rerank；api_key 加密存储）';

--
-- Name: COLUMN model_registry.model_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_registry.model_kind IS 'llm / embedding / rerank';

--
-- Name: COLUMN model_registry.source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_registry.source IS 'env / user';

--
-- Name: COLUMN model_registry.thinking_mode; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.model_registry.thinking_mode IS 'none / auto / preset / custom';

--
-- Name: chat_query_trace id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_query_trace ALTER COLUMN id SET DEFAULT nextval('public.chat_query_trace_id_seq'::regclass);

--
-- Name: flow_draft id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_draft ALTER COLUMN id SET DEFAULT nextval('public.flow_draft_id_seq'::regclass);

--
-- Name: flow_release id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_release ALTER COLUMN id SET DEFAULT nextval('public.flow_release_id_seq'::regclass);

--
-- Name: flow_workflow id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_workflow ALTER COLUMN id SET DEFAULT nextval('public.flow_workflow_id_seq'::regclass);

--
-- Name: chat_query_trace chat_query_trace_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_query_trace
    ADD CONSTRAINT chat_query_trace_pkey PRIMARY KEY (id);

--
-- Name: flow_draft flow_draft_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_draft
    ADD CONSTRAINT flow_draft_pkey PRIMARY KEY (id);

--
-- Name: flow_draft flow_draft_workflow_id_uidx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_draft
    ADD CONSTRAINT flow_draft_workflow_id_uidx UNIQUE (workflow_id);

--
-- Name: flow_release flow_release_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_release
    ADD CONSTRAINT flow_release_pkey PRIMARY KEY (id);

--
-- Name: flow_release flow_release_workflow_version_uidx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_release
    ADD CONSTRAINT flow_release_workflow_version_uidx UNIQUE (workflow_id, version);

--
-- Name: flow_workflow flow_workflow_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_workflow
    ADD CONSTRAINT flow_workflow_pkey PRIMARY KEY (id);

--
-- Name: flow_workflow flow_workflow_workflow_id_uidx; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flow_workflow
    ADD CONSTRAINT flow_workflow_workflow_id_uidx UNIQUE (workflow_id);

--
-- Name: graph_extract_task graph_extract_task_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_extract_task
    ADD CONSTRAINT graph_extract_task_pkey PRIMARY KEY (id);

--
-- Name: graph_import_task graph_import_task_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_import_task
    ADD CONSTRAINT graph_import_task_pkey PRIMARY KEY (task_id);

--
-- Name: graph_registry graph_registry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_registry
    ADD CONSTRAINT graph_registry_pkey PRIMARY KEY (kb_id, schema_id);

--
-- Name: graph_schema graph_schema_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_schema
    ADD CONSTRAINT graph_schema_pkey PRIMARY KEY (schema_id);

--
-- Name: model_registry model_registry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_registry
    ADD CONSTRAINT model_registry_pkey PRIMARY KEY (model_id);

--
-- Name: graph_schema_name_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX graph_schema_name_uidx ON public.graph_schema USING btree (schema_name);

--
-- Name: idx_chat_query_trace_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_query_trace_created ON public.chat_query_trace USING btree (created_at DESC, id DESC);

--
-- Name: idx_chat_query_trace_conversation_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_query_trace_conversation_created ON public.chat_query_trace USING btree (conversation_id, created_at DESC, id DESC);

--
-- Name: idx_chat_query_trace_org_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_query_trace_org_created ON public.chat_query_trace USING btree (org_id, created_at DESC, id DESC);

--
-- Name: idx_chat_query_trace_trace_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_query_trace_trace_id ON public.chat_query_trace USING btree (trace_id);

--
-- Name: idx_chat_query_trace_workflow_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_query_trace_workflow_created ON public.chat_query_trace USING btree (workflow_id, created_at DESC, id DESC);

--
-- Name: idx_flow_workflow_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_workflow_created_by ON public.flow_workflow USING btree (created_by);

--
-- Name: idx_flow_workflow_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_flow_workflow_name ON public.flow_workflow USING btree (name);

--
-- Name: idx_graph_extract_task_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_graph_extract_task_created_at ON public.graph_extract_task USING btree (created_at);

--
-- Name: idx_graph_extract_task_kb_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_graph_extract_task_kb_id ON public.graph_extract_task USING btree (kb_id);

--
-- Name: idx_graph_extract_task_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_graph_extract_task_status ON public.graph_extract_task USING btree (status);

--
-- Name: idx_graph_import_task_kb_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_graph_import_task_kb_id ON public.graph_import_task USING btree (kb_id);

--
-- Name: model_registry_kind_name_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX model_registry_kind_name_uidx ON public.model_registry USING btree (model_kind, model_name);

--
-- Name: chat_query_trace chat_query_trace_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER chat_query_trace_set_updated_at BEFORE UPDATE ON public.chat_query_trace FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: flow_draft flow_draft_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER flow_draft_set_updated_at BEFORE UPDATE ON public.flow_draft FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: flow_release flow_release_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER flow_release_set_updated_at BEFORE UPDATE ON public.flow_release FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: flow_workflow flow_workflow_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER flow_workflow_set_updated_at BEFORE UPDATE ON public.flow_workflow FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: graph_extract_task graph_extract_task_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER graph_extract_task_set_updated_at BEFORE UPDATE ON public.graph_extract_task FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: graph_import_task graph_import_task_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER graph_import_task_set_updated_at BEFORE UPDATE ON public.graph_import_task FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: graph_registry graph_registry_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER graph_registry_set_updated_at BEFORE UPDATE ON public.graph_registry FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: graph_schema graph_schema_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER graph_schema_set_updated_at BEFORE UPDATE ON public.graph_schema FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: model_registry model_registry_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER model_registry_set_updated_at BEFORE UPDATE ON public.model_registry FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

--
-- Name: graph_extract_task fk_graph_extract_task_kbase; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_extract_task
    ADD CONSTRAINT fk_graph_extract_task_kbase FOREIGN KEY (kb_id) REFERENCES public.kb_kbase(kbase_id) ON DELETE CASCADE;

END;
$studio_schema$;

COMMIT;
