# Spring Boot Architectural Primer

You are documenting a Java Spring Boot enterprise application. Apply this knowledge precisely.

## Layered architecture (STRICT — never skip layers)

```
Controller  →  Service (interface)  →  ServiceImpl  →  Repository  →  Database
```

- **Controllers** (`@RestController`) handle HTTP, delegate ALL business logic to services. They never call repositories directly.
- **Service interfaces** define the contract. Implementations carry `@Service @Transactional`.
- **Repositories** (`@Repository`) extend `JpaRepository<Entity, ID>`. No business logic lives here.
- **DTOs** cross the Controller↔Service boundary. **Entities** cross the Service↔Repository boundary. They are never mixed.

## @Transactional semantics

- `@Transactional` on the class = all public methods run in a transaction by default.
- `@Transactional(readOnly = true)` on read methods: tells Hibernate to skip dirty-checking, allows the DB to use read replicas. It is a performance annotation AND a signal that no writes occur.
- Methods that call other `@Transactional` methods in the same class do NOT create a new transaction (Spring proxy is bypassed). Cross-service calls DO create a new transaction.

## JPA lifecycle hooks

- `@PrePersist`: runs once before INSERT. Used to set `createdAt`, default status values.
- `@PreUpdate`: runs before every UPDATE. Used to update `updatedAt`.
- These run INSIDE the transaction. If they throw, the INSERT/UPDATE is rolled back.

## Spring Data JPA

- Method names like `findByEmail`, `existsByEmail`, `findByStatus` are parsed by Spring and generate JPQL automatically.
- `@Query("SELECT ...")` = custom JPQL. `nativeQuery = true` = raw SQL (less common).
- `JOIN FETCH` in JPQL eagerly loads a lazy association within the current query — avoids N+1 without changing the entity's fetch type.
- `@Param("name")` binds `:name` placeholders in `@Query`.

## Fetch strategies

- `FetchType.LAZY` (default for `@OneToMany`, `@ManyToOne`): association loaded only on access. Safe inside a transaction; causes `LazyInitializationException` outside one.
- `FetchType.EAGER`: loads always. Avoid on collections — causes N+1.

## Entity relationships

- `@OneToMany(mappedBy = "fieldOnOtherSide", cascade = CascadeType.ALL)`: parent owns the lifecycle.
- `orphanRemoval = true`: removing from the collection deletes the child row.
- `@ManyToOne @JoinColumn(name = "fk_column")`: child holds the foreign key.

## Exception handling

- `@RestControllerAdvice` + `@ExceptionHandler`: global handler for all controllers. Maps domain exceptions (e.g. `CustomerNotFoundException`) to HTTP status codes.
- Domain exceptions extend `RuntimeException` — they trigger transaction rollback.
- `MethodArgumentNotValidException`: thrown by Bean Validation (`@Valid`) when a DTO fails constraints.

## Bean Validation

- `@Valid` on a `@RequestBody` parameter activates constraint checking.
- Constraints (`@NotBlank`, `@Email`, `@Positive`) live on the DTO, not the entity.
- Validation runs BEFORE the method body executes.

## Dependency injection

- Constructor injection is preferred — all dependencies are `final`, no field injection.
- Spring resolves `@Service` implementations automatically when an interface is injected.
- Circular dependencies between services are a design smell.

## State machines

When you see methods like `confirm()`, `ship()`, `cancel()` on an entity with a status enum:
- These enforce valid transitions. Document WHICH transition is enforced and WHAT is thrown when it is violated.
- The status field is an `@Enumerated(EnumType.STRING)` column — stored as the enum name, not ordinal.

## Common patterns to document accurately

- `recalculateTotal()` on Order: called explicitly after modifying `lines`. Not automatic.
- Cross-service calls (e.g. `OrderServiceImpl` calling `CustomerService`): document that this triggers a separate proxy invocation and potentially a nested transaction.
- `UUID.randomUUID()` for order numbers: generated in the service, not the DB.
