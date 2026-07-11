export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      active_messages: {
        Row: {
          chat_id: number
          message_id: number
          telegram_id: number
          updated_at: string
        }
        Insert: {
          chat_id: number
          message_id: number
          telegram_id: number
          updated_at?: string
        }
        Update: {
          chat_id?: number
          message_id?: number
          telegram_id?: number
          updated_at?: string
        }
        Relationships: []
      }
      admin_logs: {
        Row: {
          action: string
          admin_telegram_id: number
          created_at: string
          details: Json | null
          id: string
          target_id: string | null
          target_type: string | null
        }
        Insert: {
          action: string
          admin_telegram_id: number
          created_at?: string
          details?: Json | null
          id?: string
          target_id?: string | null
          target_type?: string | null
        }
        Update: {
          action?: string
          admin_telegram_id?: number
          created_at?: string
          details?: Json | null
          id?: string
          target_id?: string | null
          target_type?: string | null
        }
        Relationships: []
      }
      admin_trash: {
        Row: {
          chat_id: number
          created_at: string
          message_id: number
        }
        Insert: {
          chat_id: number
          created_at?: string
          message_id: number
        }
        Update: {
          chat_id?: number
          created_at?: string
          message_id?: number
        }
        Relationships: []
      }
      announcement_deliveries: {
        Row: {
          announcement_id: string
          chat_id: number
          created_at: string
          id: string
          message_id: number | null
          read_at: string | null
          telegram_id: number
        }
        Insert: {
          announcement_id: string
          chat_id: number
          created_at?: string
          id?: string
          message_id?: number | null
          read_at?: string | null
          telegram_id: number
        }
        Update: {
          announcement_id?: string
          chat_id?: number
          created_at?: string
          id?: string
          message_id?: number | null
          read_at?: string | null
          telegram_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "announcement_deliveries_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
        ]
      }
      announcements: {
        Row: {
          created_at: string
          id: string
          preview: string
          source_chat_id: number
          source_message_id: number
          total_failed: number
          total_sent: number
        }
        Insert: {
          created_at?: string
          id?: string
          preview?: string
          source_chat_id: number
          source_message_id: number
          total_failed?: number
          total_sent?: number
        }
        Update: {
          created_at?: string
          id?: string
          preview?: string
          source_chat_id?: number
          source_message_id?: number
          total_failed?: number
          total_sent?: number
        }
        Relationships: []
      }
      blocked_users: {
        Row: {
          blocked_at: string
          blocked_until: string | null
          id: string
          infraction_count: number
          reason: string | null
          telegram_id: number
        }
        Insert: {
          blocked_at?: string
          blocked_until?: string | null
          id?: string
          infraction_count?: number
          reason?: string | null
          telegram_id: number
        }
        Update: {
          blocked_at?: string
          blocked_until?: string | null
          id?: string
          infraction_count?: number
          reason?: string | null
          telegram_id?: number
        }
        Relationships: []
      }
      bot_users: {
        Row: {
          balance: number
          chat_id: number
          created_at: string
          display_name: string | null
          id: string
          is_authenticated: boolean
          last_seen_at: string
          password_hash: string | null
          rank: Database["public"]["Enums"]["user_rank"]
          rank_assigned_at: string
          referred_by_telegram_id: number | null
          registered_at: string
          shares_count: number
          telegram_id: number
          total_recharged: number
          updated_at: string
          username: string | null
        }
        Insert: {
          balance?: number
          chat_id: number
          created_at?: string
          display_name?: string | null
          id?: string
          is_authenticated?: boolean
          last_seen_at?: string
          password_hash?: string | null
          rank?: Database["public"]["Enums"]["user_rank"]
          rank_assigned_at?: string
          referred_by_telegram_id?: number | null
          registered_at?: string
          shares_count?: number
          telegram_id: number
          total_recharged?: number
          updated_at?: string
          username?: string | null
        }
        Update: {
          balance?: number
          chat_id?: number
          created_at?: string
          display_name?: string | null
          id?: string
          is_authenticated?: boolean
          last_seen_at?: string
          password_hash?: string | null
          rank?: Database["public"]["Enums"]["user_rank"]
          rank_assigned_at?: string
          referred_by_telegram_id?: number | null
          registered_at?: string
          shares_count?: number
          telegram_id?: number
          total_recharged?: number
          updated_at?: string
          username?: string | null
        }
        Relationships: []
      }
      order_keys: {
        Row: {
          created_at: string
          delivered_at: string
          id: string
          key_value: string
          order_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          delivered_at?: string
          id?: string
          key_value: string
          order_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          delivered_at?: string
          id?: string
          key_value?: string
          order_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_keys_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_keys_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "bot_users"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          admin_message_id: number | null
          admin_note: string | null
          created_at: string
          currency: string | null
          id: string
          keys_qty: number
          order_type: string
          paid_with_balance: boolean
          payment_method_id: string | null
          price_id: string | null
          product_id: string | null
          receipt_id: string | null
          status: Database["public"]["Enums"]["order_status"]
          telegram_id: number
          total_local: number | null
          total_usd: number
          updated_at: string
          user_id: string
        }
        Insert: {
          admin_message_id?: number | null
          admin_note?: string | null
          created_at?: string
          currency?: string | null
          id?: string
          keys_qty?: number
          order_type?: string
          paid_with_balance?: boolean
          payment_method_id?: string | null
          price_id?: string | null
          product_id?: string | null
          receipt_id?: string | null
          status?: Database["public"]["Enums"]["order_status"]
          telegram_id: number
          total_local?: number | null
          total_usd: number
          updated_at?: string
          user_id: string
        }
        Update: {
          admin_message_id?: number | null
          admin_note?: string | null
          created_at?: string
          currency?: string | null
          id?: string
          keys_qty?: number
          order_type?: string
          paid_with_balance?: boolean
          payment_method_id?: string | null
          price_id?: string | null
          product_id?: string | null
          receipt_id?: string | null
          status?: Database["public"]["Enums"]["order_status"]
          telegram_id?: number
          total_local?: number | null
          total_usd?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_payment_method_id_fkey"
            columns: ["payment_method_id"]
            isOneToOne: false
            referencedRelation: "payment_methods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_price_id_fkey"
            columns: ["price_id"]
            isOneToOne: false
            referencedRelation: "product_prices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "bot_users"
            referencedColumns: ["id"]
          },
        ]
      }
      panel_action_logs: {
        Row: {
          action: string
          created_at: string
          entity: string | null
          entity_id: string | null
          id: string
          metadata: Json
        }
        Insert: {
          action: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          id?: string
          metadata?: Json
        }
        Update: {
          action?: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          id?: string
          metadata?: Json
        }
        Relationships: []
      }
      payment_methods: {
        Row: {
          account_info: string
          active: boolean
          body_raw: string | null
          country_code: string
          country_name: string
          created_at: string
          currency: string
          extra_info: string | null
          holder_name: string
          id: string
          method_name: string
          sort_order: number
          updated_at: string
          usd_rate: number
        }
        Insert: {
          account_info: string
          active?: boolean
          body_raw?: string | null
          country_code: string
          country_name: string
          created_at?: string
          currency?: string
          extra_info?: string | null
          holder_name: string
          id?: string
          method_name: string
          sort_order?: number
          updated_at?: string
          usd_rate?: number
        }
        Update: {
          account_info?: string
          active?: boolean
          body_raw?: string | null
          country_code?: string
          country_name?: string
          created_at?: string
          currency?: string
          extra_info?: string | null
          holder_name?: string
          id?: string
          method_name?: string
          sort_order?: number
          updated_at?: string
          usd_rate?: number
        }
        Relationships: []
      }
      product_categories: {
        Row: {
          created_at: string
          id: string
          name: string
          sort_order: number
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          sort_order?: number
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          sort_order?: number
        }
        Relationships: []
      }
      product_prices: {
        Row: {
          active: boolean
          created_at: string
          duration_days: number
          duration_label: string
          id: string
          original_price_usd: number | null
          price_usd: number
          product_id: string
          sale_ends_at: string | null
          sale_price_usd: number | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          duration_days: number
          duration_label: string
          id?: string
          original_price_usd?: number | null
          price_usd: number
          product_id: string
          sale_ends_at?: string | null
          sale_price_usd?: number | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          duration_days?: number
          duration_label?: string
          id?: string
          original_price_usd?: number | null
          price_usd?: number
          product_id?: string
          sale_ends_at?: string | null
          sale_price_usd?: number | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "product_prices_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
        ]
      }
      product_stock_keys: {
        Row: {
          created_at: string
          id: string
          key_value: string
          price_id: string
          product_id: string
          used: boolean
          used_at: string | null
          used_by_order_id: string | null
          used_by_user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          key_value: string
          price_id: string
          product_id: string
          used?: boolean
          used_at?: string | null
          used_by_order_id?: string | null
          used_by_user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          key_value?: string
          price_id?: string
          product_id?: string
          used?: boolean
          used_at?: string | null
          used_by_order_id?: string | null
          used_by_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_stock_keys_price_id_fkey"
            columns: ["price_id"]
            isOneToOne: false
            referencedRelation: "product_prices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_stock_keys_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_stock_keys_used_by_user_id_fkey"
            columns: ["used_by_user_id"]
            isOneToOne: false
            referencedRelation: "bot_users"
            referencedColumns: ["id"]
          },
        ]
      }
      products: {
        Row: {
          active: boolean
          category: Database["public"]["Enums"]["product_category"]
          created_at: string
          description: string | null
          id: string
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          category?: Database["public"]["Enums"]["product_category"]
          created_at?: string
          description?: string | null
          id?: string
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          category?: Database["public"]["Enums"]["product_category"]
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      rank_history: {
        Row: {
          admin_telegram_id: number | null
          changed_by: string
          created_at: string
          id: string
          new_rank: Database["public"]["Enums"]["user_rank"]
          old_rank: Database["public"]["Enums"]["user_rank"] | null
          reason: string | null
          telegram_id: number
        }
        Insert: {
          admin_telegram_id?: number | null
          changed_by?: string
          created_at?: string
          id?: string
          new_rank: Database["public"]["Enums"]["user_rank"]
          old_rank?: Database["public"]["Enums"]["user_rank"] | null
          reason?: string | null
          telegram_id: number
        }
        Update: {
          admin_telegram_id?: number | null
          changed_by?: string
          created_at?: string
          id?: string
          new_rank?: Database["public"]["Enums"]["user_rank"]
          old_rank?: Database["public"]["Enums"]["user_rank"] | null
          reason?: string | null
          telegram_id?: number
        }
        Relationships: []
      }
      rate_limits: {
        Row: {
          bucket: string
          count: number
          telegram_id: number
          window_start: string
        }
        Insert: {
          bucket: string
          count?: number
          telegram_id: number
          window_start?: string
        }
        Update: {
          bucket?: string
          count?: number
          telegram_id?: number
          window_start?: string
        }
        Relationships: []
      }
      receipt_fingerprints: {
        Row: {
          created_at: string
          file_id: string
          file_unique_id: string
          id: string
          telegram_id: number
        }
        Insert: {
          created_at?: string
          file_id: string
          file_unique_id: string
          id?: string
          telegram_id: number
        }
        Update: {
          created_at?: string
          file_id?: string
          file_unique_id?: string
          id?: string
          telegram_id?: number
        }
        Relationships: []
      }
      receipts: {
        Row: {
          admin_file_id: string | null
          admin_message_id: number | null
          created_at: string
          file_id: string
          file_size: number | null
          file_unique_id: string | null
          height: number | null
          id: string
          order_id: string | null
          status: Database["public"]["Enums"]["receipt_status"]
          telegram_id: number
          updated_at: string
          user_id: string
          width: number | null
        }
        Insert: {
          admin_file_id?: string | null
          admin_message_id?: number | null
          created_at?: string
          file_id: string
          file_size?: number | null
          file_unique_id?: string | null
          height?: number | null
          id?: string
          order_id?: string | null
          status?: Database["public"]["Enums"]["receipt_status"]
          telegram_id: number
          updated_at?: string
          user_id: string
          width?: number | null
        }
        Update: {
          admin_file_id?: string | null
          admin_message_id?: number | null
          created_at?: string
          file_id?: string
          file_size?: number | null
          file_unique_id?: string | null
          height?: number | null
          id?: string
          order_id?: string | null
          status?: Database["public"]["Enums"]["receipt_status"]
          telegram_id?: number
          updated_at?: string
          user_id?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "receipts_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "receipts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "bot_users"
            referencedColumns: ["id"]
          },
        ]
      }
      telegram_bot_settings: {
        Row: {
          created_at: string
          hide_out_of_stock: boolean
          min_recharge_usd: number
          singleton: boolean
          updated_at: string
        }
        Insert: {
          created_at?: string
          hide_out_of_stock?: boolean
          min_recharge_usd?: number
          singleton?: boolean
          updated_at?: string
        }
        Update: {
          created_at?: string
          hide_out_of_stock?: boolean
          min_recharge_usd?: number
          singleton?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      user_price_overrides: {
        Row: {
          created_at: string
          id: string
          price_id: string
          price_usd: number
          telegram_id: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          price_id: string
          price_usd: number
          telegram_id: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          price_id?: string
          price_usd?: number
          telegram_id?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_price_overrides_price_id_fkey"
            columns: ["price_id"]
            isOneToOne: false
            referencedRelation: "product_prices"
            referencedColumns: ["id"]
          },
        ]
      }
      user_state: {
        Row: {
          context: Json
          last_action_at: string
          start_lock_at: string | null
          state: string
          telegram_id: number
          updated_at: string
        }
        Insert: {
          context?: Json
          last_action_at?: string
          start_lock_at?: string | null
          state?: string
          telegram_id: number
          updated_at?: string
        }
        Update: {
          context?: Json
          last_action_at?: string
          start_lock_at?: string | null
          state?: string
          telegram_id?: number
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      apply_referral: {
        Args: { _new_user: number; _referrer: number }
        Returns: Json
      }
      purchase_key_atomic: {
        Args: { _price_id: string; _telegram_id: number }
        Returns: Json
      }
      purchase_manual_atomic: {
        Args: { _price_id: string; _telegram_id: number }
        Returns: Json
      }
    }
    Enums: {
      order_status:
        | "pending_receipt"
        | "pending_approval"
        | "approved"
        | "rejected"
        | "delivered"
        | "cancelled"
      product_category: "iOS" | "Android"
      receipt_status: "pending" | "approved" | "rejected" | "duplicate"
      user_rank:
        | "normal"
        | "pro"
        | "leyenda"
        | "gold"
        | "platinum"
        | "diamond"
        | "elite"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      order_status: [
        "pending_receipt",
        "pending_approval",
        "approved",
        "rejected",
        "delivered",
        "cancelled",
      ],
      product_category: ["iOS", "Android"],
      receipt_status: ["pending", "approved", "rejected", "duplicate"],
      user_rank: [
        "normal",
        "pro",
        "leyenda",
        "gold",
        "platinum",
        "diamond",
        "elite",
      ],
    },
  },
} as const
