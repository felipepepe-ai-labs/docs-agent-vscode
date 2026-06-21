# Angular Architectural Primer

You are documenting an **Angular 17+ application** built with standalone components, signals, and functional dependency injection. Apply this mental model before documenting any TypeScript file.

## Core architecture

Angular 17+ uses **no NgModules**. Every component, directive, and pipe is standalone — it declares its own `imports` array. The application is bootstrapped via `bootstrapApplication(App, appConfig)` where `appConfig` provides global services with `provideRouter()`, `provideHttpClient()`, etc.

## Dependency injection

Services use `inject()` — **not constructor injection**:

```typescript
export class OrderService {
  private http = inject(HttpClient);  // functional DI, no constructor needed
}
```

`@Injectable({ providedIn: 'root' })` means singleton at the application level. No module required.

## Reactivity: Signals

Prefer `signal()` over RxJS for local state:

```typescript
items  = signal<Item[]>([]);
loading = signal(false);
// in template: {{ items() }}  ← called as a function
```

Use `computed()` for derived state, `effect()` for side effects that depend on signals.

## Component anatomy

```typescript
@Component({
  selector: 'app-order-list',
  standalone: true,
  imports: [RouterLink, FormsModule, DecimalPipe],  // explicit imports
  template: `...`,   // inline template (small components) or templateUrl
})
export class OrderListComponent implements OnInit {
  private svc = inject(OrderService);
  orders = signal<Order[]>([]);

  ngOnInit() { this.load(); }
}
```

Key lifecycle hooks: `OnInit` (data fetch), `OnDestroy` (cleanup). Prefer `OnInit` over constructor for async logic.

## Template control flow (Angular 17+)

Angular 17+ uses built-in control flow — **no `*ngIf` or `*ngFor` directives**:

```html
@if (loading()) { <div>Loading…</div> }
@for (item of items(); track item.id) { <div>{{ item.name }}</div> }
@empty { <div>No items.</div> }
```

## Routing

All routes use `loadComponent` for lazy loading — no route modules:

```typescript
{ path: 'orders/:id', loadComponent: () => import('./order-detail.component').then(m => m.OrderDetailComponent) }
```

`ActivatedRoute` is injected via `inject(ActivatedRoute)`. Params: `route.snapshot.paramMap.get('id')`.

## HTTP layer

Services use `HttpClient` with typed observables:

```typescript
list(status?: OrderStatus): Observable<Order[]> {
  const params = status ? new HttpParams().set('status', status) : undefined;
  return this.http.get<Order[]>('/api/orders', { params });
}
```

Error handling in components: subscribe with `{ next, error }` handlers. Never `.subscribe(fn)` without an error handler.

## Forms

- **Reactive forms** (`ReactiveFormsModule`, `FormBuilder`, `FormGroup`, `FormArray`): for complex/dynamic forms with programmatic validation.
- **Template-driven forms** (`FormsModule`, `[(ngModel)]`): for simple filter controls.

`Validators.required`, `Validators.email`, `Validators.min()` — compose in `fb.group()`.

## Typical project structure

```
src/app/
  core/
    models/     ← TypeScript interfaces (Customer, Order, enums)
    services/   ← HttpClient wrappers, one per API resource
  features/
    customers/
      customer-list/     ← table + filter
      customer-form/     ← create / edit
      customer-detail/   ← transitions, sub-actions
    orders/
      order-list/
      order-form/        ← FormArray for line items
      order-detail/      ← state machine transitions
  app.ts          ← root component (nav shell)
  app.routes.ts   ← route tree
  app.config.ts   ← providers
```

## What to document

For **services**: document each public method — the HTTP verb, path, query params, request/response types, and error scenarios.

For **components**: document the component's responsibility, the signals it owns, and any non-obvious template logic (state transitions, FormArray manipulation).

For **models**: document each interface field's purpose and constraints (especially enums with business meaning like `OrderStatus`).

Do NOT document: getters/setters that just return a value, Angular lifecycle wiring that is self-evident, `imports` array entries.

## Grounding rules

- Cite every entry with the exact `file` path (as shown in `// FILE:` headers) and 1-based `line` number.
- Do not invent methods, fields, or behaviour not visible in the provided source.
- If a method delegates entirely to another layer (e.g., `this.http.get(...)`) say what it delegates to and why — don't just say "calls the API".
